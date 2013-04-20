define(["jquery", "google-helper", "dropbox-helper", "dropbox-provider", "gdrive-provider"], function($, googleHelper, dropboxHelper) {
	var synchronizer = {};
	
	// Dependencies
	var core = undefined;
	var fileManager = undefined;

	// Create a map with providerName: providerObject
	var providerMap = _.chain(arguments)
		.map(function(argument) {
			return argument && argument.providerType & PROVIDER_TYPE_SYNC_FLAG && [argument.providerId, argument];
		}).compact().object().value();

	// Used to know the providers we are connected to 
	synchronizer.useGoogleDrive = false;
	synchronizer.useDropbox = false;
	
	// Used to know if user can force synchronization
	var uploadPending = false;
	
	// Allows external modules to update uploadPending flag
	synchronizer.notifyChange = function(fileIndex) {
		// Check that file has synchronized locations
		if(localStorage[fileIndex + ".sync"].length !== 1) {
			uploadPending = true;
			synchronizer.updateSyncButton();
		}
	};
	
	// Used to enable/disable the synchronization button
	synchronizer.updateSyncButton = function() {
		if(syncRunning === true || uploadPending === false || core.isOffline) {
			$(".action-force-sync").addClass("disabled");
		}
		else {
			$(".action-force-sync").removeClass("disabled");
		}
	};

	// Force the synchronization
	synchronizer.forceSync = function() {
		lastSync = 0;
		synchronizer.sync();
	};
	
	// Recursive function to upload a single file on multiple locations
	var uploadFileSyncIndexList = [];
	var uploadContent = undefined;
	var uploadContentCRC = undefined;
	var uploadTitle = undefined;
	var uploadTitleCRC = undefined;
	function locationUp(callback) {
		
		// No more synchronized location for this document
		if (uploadFileSyncIndexList.length === 0) {
			fileUp(callback);
			return;
		}
		
		// Dequeue a synchronized location
		var syncIndex = uploadFileSyncIndexList.pop();
		var syncAttributes = JSON.parse(localStorage[fileSyncIndex]);
		=
		var syncContentCRC = localStorage[fileSyncIndex + ".contentCRC"];
		var syncTitleCRC = localStorage[fileSyncIndex + ".titleCRC"];
		// Skip if CRC has not changed
		if(uploadContentCRC == syncContentCRC && (syncTitleCRC === undefined || uploadTitleCRC == syncTitleCRC)) {
			locationUp(callback);
			return;
		}
		
		// If upload is going to run, go for an other upload cycle at the end
		uploadCycle = true;
		// When page is refreshed, this flag is false but should be true here
		uploadPending = true;

		// Try to find the provider
		if (fileSyncIndex.indexOf(SYNC_PROVIDER_GDRIVE) === 0) {
			var id = fileSyncIndex.substring(SYNC_PROVIDER_GDRIVE.length);
			googleHelper.upload(id, undefined, uploadTitle, uploadContent, function(error, result) {
				if(error) {
					// If error we abort the synchronization (retry later)
					callback(error);
					return;
				}
				localStorage[fileSyncIndex + ".contentCRC"] = uploadContentCRC;
				localStorage[fileSyncIndex + ".titleCRC"] = uploadTitleCRC;
				locationUp(callback);
			});
		} else if (fileSyncIndex.indexOf(SYNC_PROVIDER_DROPBOX) === 0) {
			var path = fileSyncIndex.substring(SYNC_PROVIDER_DROPBOX.length);
			path = decodeURIComponent(path);
			dropboxHelper.upload(path, uploadContent, function(error, result) {
				if (error) {
					// If error we abort the synchronization (retry later)
					callback(error);
					return;
				}
				localStorage[fileSyncIndex + ".contentCRC"] = uploadContentCRC;
				locationUp(callback);
			});
		} else {
			// This should never happen
			console.error("Invalid fileSyncIndex: " + fileSyncIndex);
			callback("error");
		}
	}

	// Recursive function to upload multiple files
	var uploadFileIndexList = [];
	function fileUp(callback) {
		
		// No more fileIndex to synchronize
		if (uploadFileIndexList.length === 0) {
			syncUp(callback);
			return;
		}
		
		// Dequeue a fileIndex
		var fileIndex = uploadFileIndexList.pop();
		var fileSyncIndexes = localStorage[fileIndex + ".sync"];
		if(!fileIndex || fileSyncIndexes.length === 1) {
			fileUp(callback);
			return;
		}

		// Get document title/content 
		uploadContent = localStorage[fileIndex + ".content"];
		uploadContentCRC = core.crc32(uploadContent);
		uploadTitle = localStorage[fileIndex + ".title"];
		uploadTitleCRC = core.crc32(uploadTitle);

		// Parse the list of synchronized locations associated to the document
		uploadFileSyncIndexList = _.compact(fileSyncIndexes.split(";"));
		locationUp(callback);
	}

	// Used to upload document changes from local storage
	var uploadCycle = false;
	function syncUp(callback) {
		if(uploadCycle === true) {
			// New upload cycle
			uploadCycle = false;
			uploadFileIndexList = localStorage["file.list"].split(";");
			fileUp(callback);
		}
		else {
			callback();
		} 
	}

	// Used to download file changes from Google Drive
	function syncDownGdrive(callback) {
		if (synchronizer.useGoogleDrive === false) {
			callback();
			return;
		}
		var lastChangeId = parseInt(localStorage[SYNC_PROVIDER_GDRIVE
			+ "lastChangeId"]);
		googleHelper.checkUpdates(lastChangeId, function(error, changes, newChangeId) {
			if (error) {
				callback(error);
				return;
			}
			googleHelper.downloadContent(changes, function(error, changes) {
				if (error) {
					callback(error);
					return;
				}
				var updateFileTitles = false;
				for ( var i = 0; i < changes.length; i++) {
					var change = changes[i];
					var fileSyncIndex = SYNC_PROVIDER_GDRIVE + change.fileId;
					var fileIndex = fileManager.getFileIndexFromSync(fileSyncIndex);
					// No file corresponding (file may have been deleted locally)
					if(fileIndex === undefined) {
						fileManager.removeSync(fileSyncIndex);
						continue;
					}
					var localTitle = localStorage[fileIndex + ".title"];
					// File deleted
					if (change.deleted === true) {
						fileManager.removeSync(fileSyncIndex);
						updateFileTitles = true;
						core.showMessage('"' + localTitle + '" has been removed from Google Drive.');
						continue;
					}
					var localTitleChanged = localStorage[fileSyncIndex + ".titleCRC"] != core.crc32(localTitle);
					var localContent = localStorage[fileIndex + ".content"];
					var localContentChanged = localStorage[fileSyncIndex + ".contentCRC"] != core.crc32(localContent);
					var file = change.file;
					var fileTitleChanged = localTitle != file.title;
					var fileContentChanged = localContent != file.content;
					// Conflict detection
					if ((fileTitleChanged === true && localTitleChanged === true)
						|| (fileContentChanged === true && localContentChanged === true)) {
						fileManager.createFile(localTitle + " (backup)", localContent);
						updateFileTitles = true;
						core.showMessage('Conflict detected on "' + localTitle + '". A backup has been created locally.');
					}
					// If file title changed
					if(fileTitleChanged) {
						localStorage[fileIndex + ".title"] = file.title;
						updateFileTitles = true;
						core.showMessage('"' + localTitle + '" has been renamed to "' + file.title + '" on Google Drive.');
					}
					// If file content changed
					if(fileContentChanged) {
						localStorage[fileIndex + ".content"] = file.content;
						core.showMessage('"' + file.title + '" has been updated from Google Drive.');
						if(fileManager.isCurrentFileIndex(fileIndex)) {
							updateFileTitles = false; // Done by next function
							fileManager.selectFile(); // Refresh editor
						}
					}
					// Update file etag and CRCs
					localStorage[fileSyncIndex + ".etag"] = file.etag;
					localStorage[fileSyncIndex + ".contentCRC"] = core.crc32(file.content);
					localStorage[fileSyncIndex + ".titleCRC"] = core.crc32(file.title);
				}
				if(updateFileTitles) {
					fileManager.updateFileTitles();
				}
				localStorage[SYNC_PROVIDER_GDRIVE
				 			+ "lastChangeId"] = newChangeId;
				callback();
			});
		});
	}

	// Used to download file changes from Dropbox
	function syncDownDropbox(callback) {
		if (synchronizer.useDropbox === false) {
			callback();
			return;
		}
		var lastChangeId = localStorage[SYNC_PROVIDER_DROPBOX + "lastChangeId"];
		dropboxHelper.checkUpdates(lastChangeId, function(error, changes, newChangeId) {
			if (error) {
				callback(error);
				return;
			}
			dropboxHelper.downloadContent(changes, function(error, changes) {
				if (error) {
					callback(error);
					return;
				}
				var updateFileTitles = false;
				for ( var i = 0; i < changes.length; i++) {
					var change = changes[i];
					var fileSyncIndex = SYNC_PROVIDER_DROPBOX + encodeURIComponent(change.path.toLowerCase());
					var fileIndex = fileManager.getFileIndexFromSync(fileSyncIndex);
					// No file corresponding (file may have been deleted locally)
					if(fileIndex === undefined) {
						fileManager.removeSync(fileSyncIndex);
						continue;
					}
					var localTitle = localStorage[fileIndex + ".title"];
					// File deleted
					if (change.wasRemoved === true) {
						fileManager.removeSync(fileSyncIndex);
						updateFileTitles = true;
						core.showMessage('"' + localTitle + '" has been removed from Dropbox.');
						continue;
					}
					var localContent = localStorage[fileIndex + ".content"];
					var localContentChanged = localStorage[fileSyncIndex + ".contentCRC"] != core.crc32(localContent);
					var file = change.stat;
					var fileContentChanged = localContent != file.content;
					// Conflict detection
					if (fileContentChanged === true && localContentChanged === true) {
						fileManager.createFile(localTitle + " (backup)", localContent);
						updateFileTitles = true;
						core.showMessage('Conflict detected on "' + localTitle + '". A backup has been created locally.');
					}
					// If file content changed
					if(fileContentChanged) {
						localStorage[fileIndex + ".content"] = file.content;
						core.showMessage('"' + localTitle + '" has been updated from Dropbox.');
						if(fileManager.isCurrentFileIndex(fileIndex)) {
							updateFileTitles = false; // Done by next function
							fileManager.selectFile(); // Refresh editor
						}
					}
					// Update file version and CRC
					localStorage[fileSyncIndex + ".version"] = file.versionTag;
					localStorage[fileSyncIndex + ".contentCRC"] = core.crc32(file.content);
				}
				if(updateFileTitles) {
					fileManager.updateFileTitles();
				}
				localStorage[SYNC_PROVIDER_DROPBOX
				             + "lastChangeId"] = newChangeId;
				callback();
			});
		});
	}
	
	function syncDown(callback) {
		syncDownGdrive(function() {
			syncDownDropbox(callback);
		});
	};
		
	var syncRunning = false;
	var lastSync = 0;
	synchronizer.sync = function() {
		// If sync is already running or timeout is not reached or offline
		if (syncRunning || lastSync + SYNC_PERIOD > core.currentTime || core.isOffline) {
			return;
		}
		syncRunning = true;
		uploadCycle = true;
		lastSync = core.currentTime;
		synchronizer.updateSyncButton();
		
		function isError(error) {
			if(error !== undefined) {
				syncRunning = false;
				synchronizer.updateSyncButton();
				return true;
			}
			return false;
		}

		syncDown(function(error) {
			if(isError(error)) {
				return;
			}
			syncUp(function(error) {
				if(isError(error)) {
					return;
				}
				syncRunning = false;
				uploadPending = false;
			});
		});
	};
	
	// Used to populate the "Manage synchronization" dialog
	var lineTemplate = ['<div class="input-prepend input-append">',
		'<span class="add-on" title="<%= provider.providerName %>">',
		'<i class="icon-<%= provider.providerId %>"></i></span>',
		'<input class="span5" type="text" value="<%= syncDesc %>" disabled />',
		'</div>'].join("");
	var removeButtonTemplate = '<a class="btn" title="Remove this location"><i class="icon-trash"></i></a>';
	synchronizer.refreshManageSync = function() {
		var fileIndex = fileManager.getCurrentFileIndex();
		var syncIndexList = _.compact(localStorage[fileIndex + ".sync"].split(";"));
		$(".msg-no-sync, .msg-sync-list").addClass("hide");
		$("#manage-sync-list .input-append").remove();
		if (syncIndexList.length > 0) {
			$(".msg-sync-list").removeClass("hide");
		} else {
			$(".msg-no-sync").removeClass("hide");
		}
		_.each(syncIndexList, function(syncIndex) {
			var syncAttributes = JSON.parse(localStorage[syncIndex]);
			var syncDesc = syncAttributes.id || syncAttributes.path;
			lineElement = $(_.template(lineTemplate, {
				provider: providerMap[syncAttributes.provider],
				syncDesc: syncDesc
			}));
			lineElement.append($(removeButtonTemplate).click(function() {
				fileManager.removeSync(syncIndex);
				fileManager.updateFileTitles();
			}));
			$("#manage-sync-list").append(lineElement);
		});
	};
	
	synchronizer.init = function(coreModule, fileManagerModule) {
		core = coreModule;
		fileManager = fileManagerModule;
		
		// Init each provider
		_.each(providerMap, function(provider) {
			provider.init(core, fileManager);
			// Provider's import button
			$(".action-sync-import-" + provider.providerId).click(function(event) {
				provider.importFiles(event);
			});
			// Provider's export button
			$(".action-sync-export-" + provider.providerId).click(function(event) {
				var fileIndex = fileManager.getCurrentFileIndex();
				var title = localStorage[fileIndex + ".title"];
				var content = localStorage[fileIndex + ".content"];
				provider.exportFile(event, title, content, function(error, syncIndex) {
					if(error) {
						return;
					}
					localStorage[fileIndex + ".sync"] += syncIndex + ";";
					synchronizer.refreshManageSync();
					fileManager.updateFileTitles();
					core.showMessage('"' + title
						+ '" will now be synchronized on ' + provider.providerName + '.');
				});
			});
			// Provider's manual sync button
			$(".action-sync-manual-" + provider.providerId).click(function(event) {
				var fileIndex = fileManager.getCurrentFileIndex();
				var title = localStorage[fileIndex + ".title"];
				var content = localStorage[fileIndex + ".content"];
				provider.exportManual(event, title, content, function(error, syncIndex) {
					if(error) {
						return;
					}
					localStorage[fileIndex + ".sync"] += syncIndex + ";";
					synchronizer.refreshManageSync();
					fileManager.updateFileTitles();
					core.showMessage('"' + title
						+ '" will now be synchronized on ' + provider.providerName + '.');
				});
			});
		});
		
		synchronizer.updateSyncButton();
		$(".action-force-sync").click(function() {
			if(!$(this).hasClass("disabled")) {
				synchronizer.forceSync();
			}
		});
	};

	return synchronizer;
});
