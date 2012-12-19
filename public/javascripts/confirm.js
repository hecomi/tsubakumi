function confirm(heading, question, cancelButtonTxt, okButtonTxt, callback) {
	var confirmModal =
		$('<div class="modal hide fade">' +
				'<div class="modal-header">' +
				'<a class="close" data-dismiss="modal" >&times;</a>' +
				'<h3>' + heading +'</h3>' +
				'</div>' +

				'<div class="modal-body">' +
				'<p>' + question + '</p>' +
				'</div>' +

				'<div class="modal-footer">' +
				'<a href="#" class="btn" data-dismiss="modal">' +
				cancelButtonTxt +
				'</a>' +
				'<a href="#" id="okButton" class="btn btn-primary">' +
				okButtonTxt +
				'</a>' +
				'</div>' +
				'</div>');

	confirmModal.find('#okButton').click(function(event) {
		callback();
		confirmModal.modal('hide');
	});

	confirmModal.modal('show');
}
