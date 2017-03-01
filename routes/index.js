var express = require('express');
var router = express.Router();
var BSON = require('mongodb').BSONPure;
var MongoClient = require('mongodb').MongoClient;
var GridStore = require('mongodb').GridStore;
var Grid = require('mongodb').Grid;
var ObjectID = require('mongodb').ObjectID;
var fs = require('fs');
var contentDisposition = require('content-disposition');
var mime = require('mime-types');

var passport = require('passport');
var config = require('../config');

var request = require('request');
var multer = require('multer');

var mongo = require('mongodb');
var Grid = require('gridfs-stream');

/* youtube support */
var ytdl = require('ytdl-core');
var async = require('async');

router.get('/login',function(req, res) {
	if(req.user) {
		res.redirect('/');
	} else {
		res.render('login', {
			user : req.user, 
			error : req.flash('error')
		});
	}
});

router.post('/login', 
	passport.authenticate('local', {
		failureRedirect: '/login',
		failureFlash: 'Błędny login/hasło' }
	), function(req, res) {
	res.redirect(req.session.returnTo || '/');
});

router.get('/logout', function(req, res) {
    req.logout();
    res.redirect('/');
});

/**
 * activate passport auth middleware
 */
router.use(function(req, res, next) {
    if(req.user) {
        next();
    } else {
		req.session.returnTo = req.path;
        res.redirect('/login');
    }
});

var viewableType = function(type) {
	return type == 'application/pdf'||
			type == 'image/png'||
			type == 'image/jpeg'||
			type == 'video/mp4'||
			type.indexOf('application/pdf') !== -1||
			type.indexOf('image/') !== -1||
			type.indexOf('video/mp4') !== -1;
};

/**
 * file upload
 */
var upload = multer({
	dest: __dirname + '/../uploads/',
	limits: {fileSize: 100000000, files:1},
});

MongoClient.connect(config.db.url, function(err, db) {
	if(err) {
		throw err;
	}
	console.log('Connected to db '+config.db.url);
	db.collectionNames(function(err, names){
		console.log('Collections:');		
		console.log(names);
	});
 
	var getUrls = function(page, search, tag, callback) {
		var urls = [];
		var urlsCollection = db.collection('urls');

		var loop = function(cursor) {
			cursor.each(function(err, i){
				if(err) {
					callback(err);
				}			
				if(i != null) {
					urls.push(i);
				} else {
					async.map(urls, function(url, callback1){
						var tags = [];
						db.collection('tags').find({_id: {$in: url.tags}}).each(function(err, tag){
							if(tag != null) {
								tags.push(tag);
							} else {
								url.tags = tags;
								callback1(null, url);
							}
						});
					}, function(err, result){					
						callback(null, result);
					});
				}
			});
		};

		if(typeof tag != 'undefined') {
			db.collection('tags').find({name:tag}).each(function(err, t){
				if(t!=null) {
					loop(db.collection('urls').find({tags: {$in: [t._id]}}).sort({_id:-1}).limit(page * 10));
				}
			});
		} else {
			loop(urlsCollection.find(search!=null?{'url' : {$regex : '.*'+search.trim()+'.*'}}:{}).sort({_id:-1}).limit(page * 10));
		}
	};

	var getById = function(id, callback) {
		var urlsCollection = db.collection('urls');
		var obj_id = BSON.ObjectID.createFromHexString(id);
		urlsCollection.findOne({_id:obj_id}, function(err,r){
			if(err) {
				return callback(err);
			};			
			callback(null, r);
		});
	};

	var updateTags = function(tags, callback) {
		console.log('updating tags...');
		var funcs = tags.map(function(tag){
			return function(callback1){
				var tag1 = {
					name: tag.trim()
				};		
				if(tag1.name == '') {
					callback1(null, null);
				} else {
					var tagInDb = db.collection('tags').find(tag1);
					tagInDb.count(function(err,count){
						if(count > 0) {
							tagInDb.each(function(err, i){
								if(i!=null) {
									callback1(null, i._id);
								}
							});
						} else {
							db.collection('tags').insert(tag1, function(err, result){
								if(err) {
									callback1(err);
								} else {
									callback1(null, tag1._id);
								}							
							});
						}
					});
				}
			};
		});
		async.parallel(funcs, function(err, results){
			if(err) {
				callback(err);	
			} else {
				callback(null, results);	
			}
		});
	};

	router.get('/list/:page?', function(req, res) {
		getUrls(req.params.page ? req.params.page : 1, req.query.search, req.query.tag, function(err, urls){
			res.render('list', { 
				urls: urls,
				page: req.params.page
			});
		}); 		
	});

	router.get('/:page?', function(req, res) {
			res.render('index', { 
				//urls: urls,
				form:{},
				query: req.query
			});
		
	});

	router.post('/', function(req, res) {
		var io = req.app.get('io');
		var socketid = req.param('socketid')

		var form = {
			url: req.param('url'),
			tags: req.param('tags')
		};
		
		var yt = form.url.lastIndexOf('https://www.youtube.com/', 0) === 0 || form.url.lastIndexOf('http://www.youtube.com/', 0) === 0 || form.url.lastIndexOf('https://youtube.com/', 0) === 0 || form.url.lastIndexOf('http://youtube.com/', 0) === 0;

		var gfs = Grid(db, mongo);
		var fileId = new ObjectID();
		var writestream = gfs.createWriteStream({
    		_id: fileId
		});

		var insertToDB = function(options, callback) {
			var url = {
				url: form.url,
				title: options.title,
				upload: false,
				type: options.type,
				grid_id: fileId
			};
			updateTags(form.tags.trim().split(','), function(err, tagids){
				if(err) {
					callback(err);
				} else {
					url.tags = tagids;
					db.collection('urls').insert(url, function(err, result) {
						if(err) {
							callback(err);
						} else {
							callback(null);
						}
					});			      				
				}
			});
		};

		if(yt) {
			console.log('youtube!');
			var ystream = ytdl(form.url, { filter: function(format) { return format.container === 'mp4'; } });

			var contentLength = 0;
			var f = 0;
			var firstChunk = true;
			var title = form.url;

			ystream
			.on('info', function(info, format){
				title = info.title;
				console.log(title);
				contentLength = format.size;
			})
			.on('data', function(chunk){
				if(firstChunk) firstChunk = false;
				f+=chunk.length;
				var pr = Math.floor(parseInt(f)/contentLength * 100);
				io.sockets.socket(socketid).emit('progress',{p:pr, count: f, of: contentLength});				
			})			
			.on('end', function(){
				console.log('end: '+title);
				insertToDB({type:'video/mp4', title: title}, function(err){
					if(err) {
						return res.status(500).send('fail');
					}
					res.status(200).send('ok');
				});
			})			
			.on('error', function(e) {
				res.status(400).send('error');
			})						
			.pipe(writestream);
		} else {
			require(form.url.lastIndexOf('https', 0) === 0?'https':'http').get(form.url, function(res1) {

				if(res1.statusCode != 200) {
		  			return res.status(400).send('Problem z pobraniem adresu');
		  		}					
		  		
				var contentLength = parseInt(res1.headers['content-length']);
				var f = 0;
  				
  				res1
  				.on('data', function(chunk) {  					
  					f+=chunk.length;
					var pr = Math.floor(parseInt(f)/contentLength * 100);
					io.sockets.socket(socketid).emit('progress',{p:pr, count: f, of: contentLength});
			    })
			    .on('end', function() {			  
					insertToDB({type: res1.headers['content-type'], title:form.url}, function(err){
						if(err) {
							return res.status(500).send('fail');
						}						
						res.status(200).send('ok');
					});
			    })
			    .on('error', function(e) {
					res.status(400).send('error');
				})
			    .pipe(writestream);
			});
		}
	});

	router.get('/get/:id', function(req,res){
		getById(req.params.id, function(err, url){
			new GridStore(db, url.grid_id, "r").open(function(err, gridStore) {
				var type = url.type == 'application/octet-stream' ? mime.lookup(url.url) : url.type;
				if(!type || !viewableType(type)) {
					res.set('Content-Disposition', contentDisposition(url.url));
				}
				res.set('Content-Type', type);
				gridStore.stream(true).pipe(res);
			});
		});
	});	

	router.post('/upload', upload.single('file'), function(req, res) {
		var io = req.app.get('io');
		var socketid = req.param('socketid');

		console.log(req.file);
		var localFile = req.file.path;
		var contentLength = req.file.size;

		var fileId = new ObjectID();
		var writestream = Grid(db, mongo).createWriteStream({
    		_id: fileId
		});

		var f = 0;

		fs.createReadStream(localFile)
		.on('data', function(chunk) {  					
			f+=chunk.length;
			var pr = Math.floor(parseInt(f)/contentLength * 100);
			io.sockets.socket(socketid).emit('progress',{p:pr, count: f, of: contentLength});
	    })		
		.on('end', function() {
			fs.unlink(localFile, function(err){
				if(!err) {
					console.log(localFile + ' deleted.');
				}
			});
			var url = {
				url: req.file.originalname,
				title: req.file.originalname,
				type: 'application/octet-stream',
				upload: true,
				grid_id: fileId
			};

			updateTags(req.param('tags').trim().split(','), function(err, tagids){
				if(err) {
					return res.status(500).send('fail');
				} else {
					url.tags = tagids;
					db.collection('urls').insert(url, function(err, result) {
						if(err) {
							return res.status(500).send('fail');
						} else {
							res.redirect('/');
						}
					});			      				
				}
			});
		})
		.pipe(writestream);
	});

});

module.exports = router;
