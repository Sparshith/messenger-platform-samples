/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const 
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),  
  request = require('request'),
  googleplaces = require('googleplaces'),
  jsonfile = require('jsonfile'),
  quickRepliesPath = __dirname + '/data/quick_replies.json',
  buttonMessagePath = __dirname + '/data/button_messages.json',
  mysql = require('mysql')


var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));


var dbConfig = config.get('mysql');
var db = mysql.createConnection({
  host     : dbConfig.host,
  user     : dbConfig.user,
  password : dbConfig.password,
  database : dbConfig.database
});
db.connect();


const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ? 
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});

app.post('/webhook', function (req, res) {
  var data = req.body;
  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;
      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've 
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                      .digest('hex');
    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

function getAllQuickReplies(callback) {
  jsonfile.readFile(quickRepliesPath, function(err, obj) {
    if(err) {
      return callback&&callback(err);
    }
    return callback&&callback(null, obj);
  });
}


function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;
  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;
 
  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", 
      messageId, appId, metadata);
    return;
  }  else if (messageAttachments) {
    /**
    * Currently assume only one attachment exists
    **/
    var attachment = messageAttachments[0];
    var attachmentType = attachment.type;

    switch (attachmentType) {
      case 'location':
        var lat = attachment.payload.coordinates.lat;
        var lon = attachment.payload.coordinates.long;
        // console.log("Contents of payload " , payload);
        // console.log(lat, lon);
        var NearBySearch = require("googleplaces/lib/NearBySearch");
        var nearBySearch = new NearBySearch(config.get('googlePlacesApiKey'), config.get('googlePlacesApiKeyOutputFormat'));
        var parameters = {
            location: [lat, lon],
            radius : 1000,
            type : ['hospital']
        };

        nearBySearch(parameters, function (error, response) {
            if(error) {
              console.log(error);
              return false;
            }

            sendTextMessage(senderID, "This is the nearest hospital to you. You're going to be alright" );
            sendTextMessage(senderID, "https://www.google.com/maps/dir/" + lat + "," + lon + "/" + response['results'][1]['name'].split(' ').join('+'));
        });
        break;
      default: 
        sendTextMessage(senderID, "Message with attachment received");
    }
  }

  else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    //Checking if quickReply exists 
    var quickReplyObjectFetched = function(err, allQuickReplies) {
      if(err) {
        console.log(err);
        return callback&&callback(err);
      }


      if(quickReplyPayload in allQuickReplies) {
       sendQuickReply(senderID, quickReplyPayload);
      }
    }
    getAllQuickReplies(quickReplyObjectFetched);

    return;
  }

  if (messageText) {
    switch (messageText) {
      case 'I was abused':
        sendQuickReply(senderID, 'askAbusedTime');
        break;
      case 'Panic Button':
        sendButtonMessage(senderID);
        break;
      case 'test db':
        var name = 'Sneha';
        var phoneNumber = '+919833092463';
        var email = 'gauri.ambavkar@snehamumbai.org';
        var query = 'INSERT INTO helplines(name, email, phone_number) VALUES(?, ?, ?)';
        var queryParams = [name, email, phoneNumber];
        db.query(query, queryParams, function(err, result){
          if(err) {
            console.log(err);
            return false;
          }
          if(result['affectedRows']) {
            sendTextMessage(senderID, 'Entry added with ID - '+ result['insertId']);
          }
        });
        break;
      default: 
        sendQuickReply(senderID, 'defaultMessage');
        break;
    }
  }
}

function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;
  var payload = event.postback.payload;
  setTypingIndicator(senderID);

  var quickReplyObjectFetched = function(err, allQuickReplies) {
    if(err) {
      console.log(err);
    }

    if(payload in allQuickReplies) {
      sendQuickReply(senderID, payload);
    }
  };

  getAllQuickReplies(quickReplyObjectFetched);

}

function sendTextMessage(recipientId, messageText, callback) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };

  callSendAPI(messageData, callback);
}

function setTypingIndicator(recipientId) {
  var messageData = {
    recipient:{
          id: recipientId
    },
    sender_action:"typing_on"
  };
  callSendAPI(messageData);
}

function sendButtonMessage(recipientId, useCase) {

  if(useCase === "suicidalThoughtsYes"){
  var messageInfo = {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "These people here will help you.",
          buttons:[{
          "type":"phone_number",
          "title":"National Helpline",
          "payload":"181"
          }]
        }
      }
    };
  }
  if(useCase === "panicButton"){

  var messageInfo = {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "You will get help here.",
          buttons:[{
          "type":"phone_number",
          "title":"Police",
          "payload":"100"
          }]
        }
      }
    };
  }

  var messageData = {
    recipient: {
      id: recipientId
    },
    message: messageInfo
  };  

  callSendAPI(messageData);
}

function getUserDetails(userId, callback) {
  request({
    uri: 'https://graph.facebook.com/v2.6/'+userId,
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'GET',
    json: {}

  }, function (error, response, body) {
    if(error) {
      return callback&&callback(error);
    }

    if(response.statusCode != 200) {
      return callback&&callback('Invalid request');
    }

    var userData = {
      firstName: body.first_name
    }

    return callback&&callback(null, userData);
  });
}

function getQuickReplyOptions(useCase, callback) {

  var quickReplyObjectFetched = function(err, allQuickReplies) {
    if(err) {
      return callback&&callback(err);
    }
    var replyOptions = allQuickReplies[useCase];
    return callback&&callback(null, replyOptions);
  };

  getAllQuickReplies(quickReplyObjectFetched);
}

function sendQuickReply(recipientId, useCase) {
  var replyOptionsFetched = function(err, replyOptions) {
    if(err) {
      console.log(err);
      return false;
    }

    for(var i in replyOptions.quick_replies) {
      var replyOption = replyOptions.quick_replies[i];
      if(replyOption.image_url) {
        replyOptions.quick_replies[i]['image_url'] = SERVER_URL + replyOption.image_url;
      }
    }

    /**
    * Define special cases here.
    **/
    if(useCase === 'getStarted') {
      return startConversation(recipientId, replyOptions);
    } 
    else if(useCase === 'findCounsellor'){
      return counsellorInfo(recipientId, replyOptions);
    }
      else if(useCase === 'abuseSexualHarassmentWork'){
      return sexualHarassmentInfo(recipientId, replyOptions);
    }
      else if(useCase === 'suicidalThoughtsYes'){
      sendButtonMessage(recipientId, useCase);
    }
      else if(useCase === 'panicButton'){
      sendButtonMessage(recipientId, useCase);
    }
     else {
      var messageData = {
        recipient: {
          id: recipientId
        }
      };
      messageData.message = replyOptions;
      callSendAPI(messageData);
    }
  }

  getQuickReplyOptions(useCase, replyOptionsFetched);
};


function counsellorInfo(userId, replyOptions) {
  var firstMessageSent = function(err) {
    if(!err) {
      sendTextMessage(userId, "Parivarthan\nhttp://www.parivarthan.org/ \n+917676602602\nychelpline@gmail.com \n\nInnersight\nhttp://www.innersight.in/ \ncounsellors@innersight.in");
    }
  };
  sendTextMessage(userId, "Here is a list of counselling services in your area.", firstMessageSent);
}


function sexualHarassmentInfo(userId, replyOptions) {
  var userDetailsFetched = function(err, userDetails) {
    var firstMessageSent = function(err) {
      if(!err) {
        var secondMessageSent = function(err) {
          if(!err) {
            var messageData = {
              recipient: {
                id: userId
              }
            };
            messageData.message = replyOptions;
            callSendAPI(messageData);
          }
        };
        sendTextMessage(userId, "Here is a handbook that can help you understand how you are empowered to act in this situation.\nhttps://goo.gl/SKCGq \nYou can also contact POSH At Work for help.\n http://www.poshatwork.com/", secondMessageSent);
      }
    };
    sendTextMessage(userId, "I'm sorry to hear that.\nSexual Harassment at the Workplace in India covers physical contact and advances; a demand or request for sexual favours; making sexually coloured remarks; showing pornography; any other unwelcome physical, verbal or non-verbal conduct of sexual nature; at the workplace.", firstMessageSent);
  }
  getUserDetails(userId, userDetailsFetched); 
}


function startConversation(userId, replyOptions) {
  var userDetailsFetched = function(err, userDetails) {
    var firstMessageSent = function(err) {
      if(!err) {
        var secondMessageSent = function(err) {
          if(!err) {
            var messageData = {
              recipient: {
                id: userId
              }
            };
            messageData.message = replyOptions;
            callSendAPI(messageData);
          }
        };
        sendTextMessage(userId, "Please remember that this is not a crisis helpline. If you are in immediate danger, we strongly urge you to call 100 to reach the national police helpline.", secondMessageSent);
      }
    };
    sendTextMessage(userId, "Hi "+  userDetails.firstName + ", thank you for reaching out. I am here to help you. ", firstMessageSent);
  }
  getUserDetails(userId, userDetailsFetched); 
}

function callSendAPI(messageData, callback) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;
      console.log("recipientId ", recipientId);
      if (messageId) {
        return callback&&callback();
      } else {
        return callback&&callback();
      console.log("Successfully called Send API for recipient %s", 
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });  
}

app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;

