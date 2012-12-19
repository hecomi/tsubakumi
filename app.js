/* ========================================================================
 *  HTTP サーバの立ち上げとその連携部分
 *  	- DB への保存 / 読み出し
 *  	- Express での HTTP サーバ立ち上げ
 *  	- Socket.io でのリアルタイムな赤外線の学習やテスト
 * ======================================================================== */

/* ------------------------------------------------------------------------
 *  モジュールの読み込み
 * ------------------------------------------------------------------------ */
// {{{
var Settings  = require('./setting.js')
  , express   = require('express')
  , routes    = require('./routes')
  , http      = require('http')
  , path      = require('path')
  , mongoose  = require('mongoose')
  , Schema    = mongoose.Schema
  , ObjectId  = Schema.ObjectId
  , async     = require('async')
  , socketio  = require('socket.io')
  , printf    = require('printf')
  , iRemocon  = require('iRemocon')
  , iremocon  = new iRemocon(Settings.iRemocon.ip)
  , iRemocon  = require('iRemocon')
  , Julius    = require('julius')
  , grammar   = new Julius.Grammar()
  , julius    = null
  , OpenJTalk = require('openjtalk')
  , TTS       = new OpenJTalk()
;

// }}}

/* ------------------------------------------------------------------------
 *  MongoDB
 * ------------------------------------------------------------------------ */
// {{{
// 機器カテゴリ
var DeviceSchema = new Schema({
	name  : String,
	funcs : [FuncSchema]
});

// デバイスの機能と iRemocon の IR 番号を紐付ける
var FuncSchema = new Schema({
	ir      : { type: Number, min: 0, max: 1500 }, // iRemocon での IR 番号
	name    : { type: String,  default: '' },      // 機能の名称
	command : { type: String,  default: '' },      // Julius や Twitter での音声認識じなどに用いる呼びかけ
	reply   : { type: String,  default: '' }       // ↑の応答
});

// コマンド
var CommandSchema = new Schema({
	type    : { type: Number,  default: 1  },
	command : { type: String,  default: '' },
	func    : { type: String,  default: '' },
	reply   : { type: String,  default: '' }
});

var Device  = mongoose.model('Device',  DeviceSchema);
var Func    = mongoose.model('Func',    FuncSchema);
var Command = mongoose.model('Command', CommandSchema);

mongoose.connect('mongodb://localhost/HomeAutomationSystem');
// }}}

/* ------------------------------------------------------------------------
 *  コマンドマップ
 * ------------------------------------------------------------------------ */
// {{{
var Interpreter = {
	map_ : {},
	add  : function(command, func, reply) {
		if ( this.map_.hasOwnProperty(command) ) {
			console.error('同じコマンドが既に存在します:', command);
			return;
		}
		this.map_[command] = function(arg, talkFlag, callback) {
			if (talkFlag && reply != '') {
				TTS.talk(reply, function(err) {
					if (err) throw err;
					var result = func(arg);
					if (callback) callback(null, result);
				});
			} else {
				var result = func(arg);
				if (callback) callback(null, result);
			}
		}
	},
	run  : function(sentence, talkFlag, callback) {
		for (var x in this.map_) {
			if ( new RegExp(x).test(sentence) ) {
				this.map_[x](sentence, talkFlag, callback);
				return;
			}
		}
	},
	runScript : function(script) {

	},
}

// 機器
Device.find({}, function(err, devices) {
	devices.forEach(function(device) {
		device.funcs.forEach(function(func) {
			var command = device.name + 'を?' + func.command;
			Interpreter.add(command, function(str) {
				iremocon.is(func.ir);
			}, func.reply);
		});
	});
});

// コマンド
Command.find({}, function(err, commands) {
	commands.forEach(function(command) {
		if (command.type === 1) { // 自然言語
			var func = function(args) {
				command.func.split(';\n').forEach(function(sentence) {
					if (sentence) {
						console.log(sentence);
						try {
							eval(sentence);
						} catch(e) {
							sentence = sentence.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
							Interpreter.run(sentence, false);
						}
					}
				});
			}
			Interpreter.add(command.command, func, command.reply);
		} else { // スクリプト
			var func = function(args) {
				eval(
					'(function(args) {\n' +
						command.func +
					'})(command);'
				);
			}
			Interpreter.add(command.command, func, command.reply);
		}
	});
});

// }}}

/* ------------------------------------------------------------------------
 *  Julius
 *    音声認識する
 * ------------------------------------------------------------------------ */
// {{{

// 誤認識対策（ゴミワードを混ぜておく）
var gomi = 'あいうえおかきくけこさしすせそ';
for (var i = 0; i < gomi.length; ++i) {
	for (var j = 0; j < gomi.length; ++j) {
		grammar.add(gomi[i] + gomi[j]);
	}
}

async.series([
	// 機器の機能を操作する文章を登録
	// 機器シンボルもつくっておく
	function(callback) {
		Device.find({}, function(err, devices) {
			var deviceNameArr = [];
			devices.forEach(function(device) {
				if (device.name != undefined && device.name != '') {
					deviceNameArr.push(device.name);
					var cmd = device.name + '(を)?('
					device.funcs.forEach(function(func) {
						cmd += func.command + '|';
					});
					// 最後の | を消す
					cmd = cmd.slice(0, -1) + ')';
					grammar.add(cmd);
				}
			});
			grammar.addSymbol('DEVICE', deviceNameArr);
			callback();
		});
	},
	// マクロ / コマンドを実行する文章を登録
	function(callback) {
		Command.find({}, function(err, commands) {
			commands.forEach(function(command) {
				if (command.command !== '') {
					grammar.add(command.command);
				}
			});
			callback();
		});
	},
	function(callback) {
		grammar.compile(function(err, result) {
			if (err) throw err;
			julius = new Julius( grammar.getJconf() );
			grammar.deleteFiles();
			julius.on('result', function(str) {
				console.log(str);
				Interpreter.run(str, true);
			});
			callback();
		});
	},
	function() {
		julius.start();
	}
]);

// }}}

/* ------------------------------------------------------------------------
 *  Express
 *    HTTP サーバを立ち上げる
 * ------------------------------------------------------------------------ */
// {{{
// サーバの設定
var app = express();
app.configure(function() {
	app.set('port', process.env.PORT || 10080);
	app.set('views', __dirname + '/views');
	app.set('view engine', 'ejs');
	app.use(express.favicon());
	app.use(express.logger('dev'));
	app.use(express.bodyParser());
	app.use(express.methodOverride());
	app.use(app.router);
	app.use(express.static(path.join(__dirname, 'public')));
});
app.configure('development', function() {
	app.use(express.errorHandler());
});

// デバイスの機能を追加
app.get(/^\/devices\/?$/, function(req, res) {
	Device.find({}, function(err, docs) {
		res.render('devices', {
			error   : err,
			message : '',
			title   : 'Devices',
			devices : docs || []
		});
	});
});

// 機器を追加する際に処理する/表示する内容
app.post('/devices/add', function(req, res) {
	if (!req.body.name) {
		Device.find({}, function(err, docs) {
			res.render('devices', {
				error   : 'デバイス名を入力して下さい',
				message : null,
				title   : 'Devices',
				devices : docs || []
			});
		});
	}
	var device = new Device();
	device.name = req.body.name;
	device.save(function(err) {
		Device.find({}, function(err, docs) {
			res.render('devices', {
				error   : err,
				message : req.body.name + 'を追加しました',
				title   : 'Devices',
				devices : docs || []
			});
		});
	});
});

// 機器を削除する際に処理する/表示する内容
app.post('/devices/delete', function(req, res) {
	Device.remove({ _id: req.body._id }, function(err) {
		Device.find({}, function(err, devices) {
			res.render('devices', {
				error   : err,
				message : req.body.name + 'を削除しました',
				title   : 'Devices',
				devices : devices || []
			});
		});
	});
});

// コマンドを追加
app.get(/^\/commands(\/|$)/, function(req, res) {
	Command.find({}, function(err, commands) {
		console.log(commands);
		res.render('commands', {
			message  : '',
			title    : 'Commands',
			commands : commands || []
		});
	});
});

// Express でサーバを立ち上げる
var server = http.createServer(app).listen(app.get('port'), function() {
	console.log("Express server listening on port " + app.get('port'));
});

// }}}

/* ------------------------------------------------------------------------
 *  Socket.io
 *    リアルタイムに Web ブラウザとやり取りして、
 *    iRemocon の IR の学習やテスト、機能の名称や
 *    Julius や Twitter での呼びかけや応答の MongoDB への登録を行う
 * ------------------------------------------------------------------------ */
// {{{
var io = socketio.listen(server);

// Socket.io の接続時のイベント登録
io.sockets.on('connection', function(socket) {
	socket.emit('response', 'サーバと接続しました。');

	// エラー時の処理
	function hasErr(err, data, emitTarget, msg) {
		if (err) {
			console.error(err);
			socket.emit(emitTarget, {
				_id   : data._id,
				error : msg || err
			});
			return true;
		}
		return false;
	}

	/* iremocon/*
	 * ------------------------------------------------------------------------ */
	// iRemocon の生存確認
	socket.on('iremocon/au', function() {
		console.log('[iremocon/au]');
		iremocon.au(function(err, msg) {
			socket.emit('iremocon/au', {
				error : err,
				msg   : msg
			});
		});
	});

	/* devices/funcs/*
	 * ------------------------------------------------------------------------ */
	// 機器の機能を追加する
	socket.on('devices/funcs/add', function(data) {
		console.log('[devices/funcs/add]', data);
		async.waterfall([
			// 空き IR 番号を調べる
			function (callback) {
				Device.find({}, function(err, devices) {
					if ( hasErr(err, data, 'devices/funcs/add') ) {
						return;
					}
					var irs = [];
					devices.forEach(function(device) {
						device.funcs.forEach(function(func) {
							irs.push(func.ir);
						});
					});
					callback(null, searchNotUsedMinVal(irs));
				});
			},
			// 新しいデバイスの機能データを DB に書き込んで、
			// クライント側へその結果を返す
			function (ir, callback) {
				var func = new Func({ir : ir});
				Device.update({ _id: data._id }, { $push : { funcs : func } }, function(err) {
					if ( hasErr(err, data, 'devices/funcs/add') ) {
						return;
					}
					socket.emit('devices/funcs/add', {
						_id  : data._id,
						func : {
							ir      : ir,
							name    : '',
							command : '',
							reply   : ''
						}
					});
				});
			}
		], function(err) {
			if ( hasErr(err, data, 'devices/funcs/add') ) {
				return;
			}
		});
	});

	// IR を学習する
	socket.on('devices/funcs/learn', function(data) {
		console.log('learn', data);
		iremocon.ic(data.ir, function(err, msg) {
			if ( hasErr(err, data, 'devices/funcs/learn', (err ? err.error + ': ' + err.detail : '') ) ) {
				return;
			}
			socket.emit('devices/funcs/learn', {
				_id  : data._id,
				msg  : msg,
				func : { ir : data.ir }
			});
		});
	});

	socket.on('devices/funcs/cancel', function(data) {
		console.log('cancel', data);
		iremocon.cc(function(err, msg) {
			if ( hasErr(err, data, 'devices/funcs/cancel', (err ? err.error + ': ' + err.detail : '') ) ) {
				return;
			}
			socket.emit('devices/funcs/cancel', {
				_id  : data._id,
				msg  : msg,
				func : { ir : data.ir }
			});
		});
	});

	// 学習した IR をテストする
	socket.on('devices/funcs/test', function(data) {
		console.log('test', data);
		iremocon.is(data.ir, function(err, msg) {
			if ( hasErr(err, data, 'devices/funcs/test', (err ? err.error + ': ' + err.detail : '') ) ) {
				return;
			}
			socket.emit('devices/funcs/test', {
				_id  : data._id,
				msg  : msg,
				func : { ir : data.ir }
			});
		});
		// TTS する
		console.log(data.reply);
		TTS.talk(data.reply.toString());
	});

	// 機能の名称/呼びかけ/応答を更新する
	socket.on('devices/funcs/update', function(data) {
		console.log('[devices/funcs/update]', data);
		Device.findOne({ _id : data._id }, function(err, doc) {
			if ( hasErr(err, data, 'devices/funcs/update') ) {
				return;
			}

			// IR 番号が同じ物を探して送られてきたデータを代入して更新
			// ToDo: 現状 update では funcs 全体をアップデートしているが、
			//       一部のみアップデートするようにしたい（書き方分からない）
			var isFuncFound = false;
			for (var i in doc.funcs) {
				if (doc.funcs[i].ir === data.ir) {
					var funcs = doc.funcs;
					funcs[i].name    = data.name;
					funcs[i].command = data.command;
					funcs[i].reply   = data.reply;
					Device.update({ _id: data._id }, { funcs : funcs }, function(err) {
						if ( hasErr(err, data, 'devices/funcs/update') ) {
							return;
						}
						socket.emit('devices/funcs/update', {
							_id  : data._id,
							func : funcs[i]
						});
					});
					isFuncFound = true;
					return;
				}
			}
			// 更新しようとした関数が DB になかったらエラーをクライアントへ返す
			if (isFuncFound === false) {
				var errMsg = printf('%s\'s func@IR=%d is not found.', doc.name, data.ir);
				socket.emit('devices/funcs/update', {
					error : errMsg,
					_id   : data._id,
					func  : {ir : data.ir}
				});
			}
		});
	});

	// 機器の機能を削除する
	socket.on('devices/funcs/delete', function(data) {
		console.log('[devices/funcs/delete]', data);
		Device.update({ _id : data._id }, { $pull : { funcs : { ir : data.ir} } }, function(err) {
			if (err) {
				console.error(err);
				socket.emit('devices/funcs/delete', {
					error : err,
					_id   : data._id,
					func  : {ir : data.ir}
				});
				return;
			}
			socket.emit('devices/funcs/delete', {
				_id  : data._id,
				func : {ir : data.ir}
			});
		});
	});

	/* commands/*
	 * ------------------------------------------------------------------------ */
	// コマンドを追加する
	socket.on('commands/add', function(data) {
		console.log('[commands/add]', data);
		var command = new Command();
		command.save(function(saveErr) {
			if (saveErr) {
				if (saveErr) console.error(saveErr);
				socket.emit('commands/add', {
					error : saveErr,
				});
				throw err;
			}
			// セーブした _id を取得するために使う
			Command.findOne({}, null, {sort : [['_id', 'descending']]}, function(findErr, doc) {
				if (findErr) {
					if (findErr) console.error(findErr);
					socket.emit('commands/add', {
						error : findErr,
					});
					throw findErr;
				}
				socket.emit('commands/add', {
					_id     : doc._id,
					command : '',
					func    : '',
					type    : '',
					reply   : ''
				});
			});
		});
	});

	// コマンドを削除する
	socket.on('commands/delete', function(data) {
		console.log('[commands/delete]', data);
		Command.remove({ _id : data._id }, function(err) {
			if (err) {
				console.error(err);
				socket.emit('commands/delete', {
					error : err,
					_id   : data._id,
				});
				throw err;
			}
			socket.emit('commands/delete', {
				_id   : data._id,
			});
		});
	});

	// コマンドを更新する
	socket.on('commands/update', function(data) {
		console.log('[commands/update]', data);
		Command.update({ _id : data._id }, {
			$set : {
				type    : data.type,
				command : data.command,
				func    : data.func,
				reply   : data.reply
			}
		}, function(err) {
			if (err) {
				console.error(err);
				socket.emit('commands/update', {
					error : err,
					_id   : data._id,
				});
				throw err;
			}
			socket.emit('commands/update', {
				_id  : data._id,
			});
		});
	});

	// コマンドをテストする
	socket.on('commands/test', function(command) {
		console.log('[commands/test]', command);
		if (command.type == 1) { // 自然言語
			var result = '自然言語として実行しました:<br />\n'
			command.func.split(';\n').forEach(function(sentence) {
				if (sentence) {
					try {
						eval(sentence);
						result += '&lt;javascript&gt;' + sentence + '&lt;/javascript&gt;<br />\n'
					} catch(e) {
						sentence = sentence.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
						result += sentence + '<br />\n';
						Interpreter.run(sentence, false);
					}
				}
			});
			if (command.reply) TTS.talk(command.reply);
			socket.emit('commands/test', {
				command : command.command,
				_id     : command._id,
				result  : result
			});
		} else { // スクリプト
			try {
				var result = eval(
					'(function(args) {\n' +
						command.func +
					'})(command);'
				);
				if (command.reply) TTS.talk(command.reply);
				socket.emit('commands/test', {
					command : command.command,
					_id     : command._id,
					result  : result
				});
			} catch(e) {
				console.error(e);
				socket.emit('commands/test', {
					error   : e.toString(),
					command : command.command,
					_id     : command._id,
				});
			}
		}
	});

});

// }}}

/* ------------------------------------------------------------------------
 *  utility functions
 * ------------------------------------------------------------------------ */
// {{{
// 配列の中で最小の空き値を探す
// 空いている ir 番号を調べるために使う
function searchNotUsedMinVal(arr) {
	var minVal = 1;
	var sortedArr = arr.sort(function(a,b){return a-b;});
	for (var i = 0; i < sortedArr.length; ++i) {
		if (i === 0) continue;
		if (sortedArr[i] - sortedArr[i-1] > 1) {
			minVal = sortedArr[i-1] + 1;
			break;
		}
		if (i === sortedArr.length - 1) {
			minVal = sortedArr[i] + 1;
		}
	}
	return minVal;
}
// }}}

/* ------------------------------------------------------------------------
 *  最低限の例外処理
 * ------------------------------------------------------------------------ */
// {{{

process.on('uncaughtException', function (err) {
	console.log('uncaughtException => ' + err);
});

// }}}
