var config = require('./config.js');
var mongodbUrl = 'mongodb://' + config.mongodbHost + ':27017/marvel';
var MongoClient = require('mongodb').MongoClient
var Q = require('q');

var FIELDS_TO_SEARCH = [
  'name',
  'wiki.real_name',
  'wiki.alias',
  'description',
  'wiki.occupation',
  'wiki.place_of_birth',
  'wiki.groups',
  'wiki.relatives',
  'wiki.hair',
  'wiki.powers',
  'wiki.abilities'
];

var COMICS_FIELDS_TO_SEARCH = [
  'title',
  'issueNumber',
  'description',
  'creators'
];

// GET A SINGLE CHARACTER
// passed in the character ID and optional pagination page
exports.getCharacter = function (charId, page) {
  var out = {};
  var comicResults;
  var deferred = Q.defer();

  // Normalize stuff.
  charId = parseInt(charId);
  page = parseInt(page) || 1;

  MongoClient.connect(mongodbUrl, function (err, db) {
    var collection = db.collection('characters');

    collection.findOne({'id' : charId})
      .then(function (character) {
        console.log("FOUND", character.name);
        out = character;

        return getComicsByCharacter(db, character, (page - 1) * 20)
      })
      .then(function (comics) {
        cleanUpCharacterData(out);
        out.comics = comics;

        deferred.resolve(out);

        db.close()
      })
      .catch(function (error) {
        console.log("ERROR", error);
      });
  });

  return deferred.promise;
}

// SEARCH CHARACTERS
// This converts query parameters into a MongoDB search.
exports.getCharacters = function (options) {
  var options = options || {};
  var builtSearch = {};
  var deferred = Q.defer();

  // Normalize options.
  options.offset = parseInt(options.offset) || 0;
  
  if (options.field) {
    // For a real name, we search both 'wiki.real_name' and 'wiki.alias'
    if (options.field == 'wiki.real_name') {
      builtSearch['$or'] = [
        { 'wiki.real_name' : { '$regex' : options.query,
                               '$options' : 'i' } },
        { 'wiki.alias'     : { '$regex' : options.query,
                               '$options' : 'i' } }
      ];
    }
    else {
      builtSearch[options.field] = {
        '$regex' : options.query,
        '$options' : 'i'
      };
    }
  } else {
    // This builds a MongoDB search query across all fields.
    builtSearch['$or'] = buildMultiFieldSearch(options.query, FIELDS_TO_SEARCH);
  }

  if (options.gender) {
    builtSearch['gender'] = options.gender;
  }

  if (options.reality) {
    builtSearch['wiki.universe'] = options.reality;
  }

  console.log("SEARCH characters", JSON.stringify(builtSearch));
  
  return searchCollection ('characters', builtSearch, options.offset, {name: 1});
}

// SEARCH ALL COMICS
exports.getComics = function (options) {
  var options = options || {};
  var builtQuery = {};

  // if no term is specified, get everything
  if (!options.query) options.query = '.*';

  if (options.field) {
    builtQuery[options.field] = {
      '$regex' : options.query,
      '$options' : 'i'
    };
  } else {
    builtQuery['$or'] = buildMultiFieldSearch(options.query, COMICS_FIELDS_TO_SEARCH);
  }

  console.log("COMICS query", JSON.stringify(builtQuery));

  return searchCollection ('comics', builtQuery, options.offset, {title: 1, issueNumber: 1})
}

// GET SINGLE COMIC
exports.getComic = function (id) {
  var out = {};
  var characterResults;
  var topDeferred = Q.defer();
  id = parseInt(id);
  
  MongoClient.connect(mongodbUrl, function (err, db) {
    var collection = db.collection('comics');
    var out = {};

    // First retrieve comics data.
    return collection.findOne({'id' : id})
      .then(function (out) {
        var deferred = Q.defer();

        console.log("COMIC", id, out.title);
        
        // split the title into title and subtitle
        var temp = out.title.search(/(:|\()/mi);

        // keep the paranthasis but not the colon
        var skipChar = (out.title.indexOf(':') >= 0) ? 1:0;

        if (temp >= 0) {
	  out.subtitle = out.title.substring(temp+skipChar);
	  out.title = out.title.substring(0, temp);
        }

        // replace and <br> or \r characters
        if (out.description)
          out.description = out.description.trim().replace(/(<br>|\r)/gmi, '\n').trim();

        deferred.resolve(out);

        return deferred.promise;
      })
      .then(function (comic) {
        // Retrieve the characters for this comic.
        out = comic;

        return getCharactersByComic(db, comic);
      })
      .then(function (characters) {
        out.characters = characters;

        topDeferred.resolve(out);

        db.close();

        return topDeferred.promise;
      })
      .catch(function (err) {
        console.log("ERR", err);
      })

  });

  return topDeferred.promise;
}

// GET COMICS BY CHARACTER ID
// passed in Character object and optional pagination page
function getComicsByCharacter (db, character, offset, limit) {
  var deferred = Q.defer();
  var comicIds = [];
  offset = offset || 0;
  limit = limit || 20;
  
  // Collect comic IDs
  character.comics.items.forEach(function (item) {
    if (0 < item.id) {
      comicIds.push(item.id);
    }
  });

  if (0 < comicIds.length) {
    // Search MongoDB comics collection
    db.collection('comics').find({'id': {'$in': comicIds}})
      .sort({'id': 1})
      .skip(offset)
      .toArray(function (err, docs) {
        if (null != err) {
          deferred.reject(err);
        }
        else {
          deferred.resolve(docs.slice(0, limit));
        }
      });
  }
  else {
    deferred.resolve([]);
  };

  return deferred.promise;
}

// FIND ALL CHARACTER THAT APPEAR IN A COMIC
function getCharactersByComic (db, comic) {
  var deferred = Q.defer();

  // Collect character IDs.
  var characterIds = [];
  comic.characters.items.forEach(function (item) {
    var charId = parseInt(item.resourceURI.split('/').pop());

    if (0 < charId) {
      characterIds.push(charId);
    }
  });

  console.log("COMIC character IDs", JSON.stringify(characterIds));

  if (0 == characterIds.length) {
    deferred.resolve([]);
  }
  else {
    db.collection('characters').find({'id': {'$in': characterIds}})
      .sort({'name': 1})
      .toArray(function (err, docs) {
        if (null != err) {
          deferred.reject(err);
        }
        else {
          deferred.resolve(docs);
        }
      });
  }
  
  return deferred.promise;
}

// breaks the character name onto two lines for display
function cleanUpCharacterData (out) {
  // split the name by ()'s into subtitle
  var temp = out.name.indexOf('(');

  if (temp >= 0) {
    out.subtitle = out.name.substring(temp);
    out.name = out.name.substring(0, temp);
  }

  // split the wiki data into an array
  if (out.wiki && out.wiki.debut) out.wiki.debut = out.wiki.debut.split(',');
  if (out.wiki && out.wiki.origin) out.wiki.origin = out.wiki.origin.split(',');
}

// breaks the comic name onto two lines for display
function cleanUpComicData (out) {
  // split the name by ()'s into subtitle
  var temp = out.title.indexOf('(');

  if (temp >= 0) {
    out.subtitle = out.title.substring(temp);
    out.title = out.title.substring(0, temp);
  }
}

function buildMultiFieldSearch (query, fieldArray) {
  var searchArray = [];

  fieldArray.forEach(function (fieldName) {
    var queryObj = {};

    queryObj[fieldName] = { "$regex"   : query,
                            "$options" : 'i' };
        
    searchArray.push(queryObj);
  });

  return searchArray;
}

function searchCollection (collectionName, query, offset, sortCriteria) {
  var deferred = Q.defer();
  offset = offset || 0;
  
  // Execute the MongoDB search
  MongoClient.connect(mongodbUrl, function (err, db) {
    var collection = db.collection(collectionName);

    collection.find(query)
      .sort(sortCriteria)
      .skip(offset)
      .toArray(function (err, docs) {
        if (null != err) {
          deferred.reject(err);
        }
        else {
          console.log("SEARCH found", docs.length);
          
          deferred.resolve(docs);
        }
            
        db.close();
      });
  });

  return deferred.promise;
}
