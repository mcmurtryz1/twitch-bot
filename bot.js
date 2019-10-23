//Define writeQueue class for logging
class writeQueue {
	constructor(path) {
		this.queue = []
		this.path = path;
	}

	next() {
		if (this.queue.length != 0) {
			fs.appendFile(this.path, this.queue[0] + '\n', 'utf8', (err) => {
				this.queue.shift();
				if (this.queue.length != 0) this.next();
			});
		}
	}

	add(message) {
		this.queue.push(message);
		if (this.queue.length === 1) {
			this.next();
		}
	}
}

//Library requirements
const mysql = require('mysql');
const getData = require('node-fetch');
const twitchBot = require('twitch-bot');
const moment = require('moment');
const mqtt = require('mqtt');
const fs = require('fs');
const badWords = require('bad-words');
const { spawn } = require('child_process');

//Read the config file
const config = JSON.parse(fs.readFileSync('./config/config.json').toString());

//Time the bot was started
let startTime = new Date();

//Number of points given per minute
let ppm = config.ppm;

//Google api key for youtube calls
let googleAPI = config.googleAPI;

//Twitch api key for live calls
let twitchApi = config.twitchClientId;

//Are songs enabled
let songsEnabled = config.songsDefault;

//Is rev live
let isLive = config.isLive;

//Are songs being sent over mqtt
let mqttSend = config.mqttStatus;

//Betting choices
let betChoices = [];

//Is there a bet going
let betStart = false;

//superusers and bot owner for permission purposes
let privilegedUsers = config.privilegedUsers;
let superUsers = config.superUsers;
let botOwner = config.botOwner;

//mqtt settings
let settings = [{
	host: config.mqttHost,
	port: config.mqttPort,
	username: config.mqttUser,
	password: config.mqttPassword
}];

//Maximum song length in minutes
let shortSongLength = config.shortSongLength;
let longSongLength = config.longSongLength;

//Youtube auto confirm restrictions
let requiredViewCount = config.viewCount;
let requiredLikePercentage = config.likePercentage;

//Connect to mqtt
let mqttClient = mqtt.connect(config.mqttServer, settings);

//Read the bets file to see if there were any uncleared bets
fs.readFileSync('./bets.txt', (err, result) => {
	if (err) errorQueue.add(err.message);
	if (result.toString() != '' && result.toString() != undefined) {
		sep = result.toString().split(',');
		for (let x = 0; x < sep.length; x++) {
			betChoices[x] = sep[x];
		}
		betStart = true;
	}
});

//Read the counters file and setup all counters
let counters = JSON.parse(fs.readFileSync('./config/counters.json').toString());

//Read the follow message file and put it into an array
let followMessages = JSON.parse(fs.readFileSync('./config/followmessages.json').toString());

//Read the echo commands and store them as an object with properties
let echoCommands = JSON.parse(fs.readFileSync('./config/echoCommands.json').toString());

//Read the quotes file
let quotes = JSON.parse(fs.readFileSync('./config/quotes.json').toString());

//Temporarily assign an empty channel name
let channelName = '';

//Assign global point values
const pointValues = JSON.parse(fs.readFileSync('./config/points.json').toString());
const endStreamThreshold = pointValues.endStreamThreshold;
const normalWinMultiplier = pointValues.normalWinMultiplier;
const jackpotMultiplier = pointValues.jackpotMultiplier;
const regularSongRequest = pointValues.regularSongRequest;
const longSongRequest = pointValues.longSongLength;


//Make the handling error variable
let handlingError = false;

//Make the writeQueues
const messageQueue = new writeQueue('./logs/messages.txt');
const errorQueue = new writeQueue('./logs/errors.txt');
const statusQueue = new writeQueue('./logs/status.txt');
const logsQueue = new writeQueue('./logs/logs.txt');

//Log mqtt connection when connected
mqttClient.on('connect', function () {
	statusQueue.add('[MQTT] Connected');
});



//Create a mysql pool for concurrent connections
var con = mysql.createPool({
	connectionLimit: config.dbConnections,
	host: config.dbHost,
	user: config.dbUser,
	password: config.dbPassword,
	database: config.dbName
});

//Distribute points every minute
setInterval(distributePoints, 60 * 1000);

//Say a follow or sub message every 10 minutes
setInterval(sayFollowMessage, 30 * 60 * 1000);

//Create the twitch bot client
let client = new twitchBot({
	username: config.twitchUser,
	oauth: config.twitchOauth,
	channels: config.channels
});

//Log the channel that was joined
client.on('join', channel => {
    statusQueue.add(`[JOINING] ${channel}`);
    channelName = channel.split('#')[1];
});

//Do something when a message is put in chat
client.on('message', chatter => {
	//assign the username and the message to easy to use variables
	let username = chatter.username.toLowerCase();
	let commandName = chatter.message.toLowerCase();

	//Ignore the bots talking
	if (username == config.twitchUser) return;

	//Put whoever talked in the talked table in the db
	createTalked(username);

	//Restart the bot only for the bot owner
	if (username == botOwner && commandName == "!restart") {
		restartProcess();
	}

	//Log messages only for botowner
	if (username == botOwner && commandName.match("!log")) {
		if (commandName == '!log current data') {
			logsQueue.add(`[LOGGING] ${client}`);
		} else if (commandName == '!log channels') {
			logsQueue.add(`[LOGGING] ${client.channels}`);
		}
	}

	//Echos the bots up time
	else if (superUsers.includes(username) && commandName == '!botUptime') {
		let today = new Date();
		client.say(getFormattedTimeBetween(today.getTime() - startTime.getTime()));
	}

	//Allows bot owner to give or remove points
	else if (username == botOwner && (commandName.match(/^removepoints/g) || commandName.match(/^givepoints/g))) {
		let sep = commandName.split(' ');
		if (commandName.match(/^!removepoints/g)) {
			removePoints(sep[1], sep[2]);
			getPoints(sep[2], (result) => {
				client.say(`${sep[2]} now has ${result.points}.`)
			});
		} else if (commandName.match(/^!givepoints/g)) {
			addPoints(sep[1], sep[2]);
			getPoints(sep[2], (result) => {
				client.say(`${sep[2]} now has ${result.points}.`)
			});
		}
	}

	//Make sure channel is live
	else if (isLive || superUsers.includes(username)) {

		//Check for echo commands
		if (echoCommands[commandName] != undefined) {
			client.say(echoCommands[commandName]);
		}

		//Repeat all list of all echo commands
		//Todo either hard code in all non echo commands or find a way to populate a list
		else if (commandName == '!commands') {
			let printString = "";
			for (property of Object.getOwnPropertyNames(echoCommands)) {
				printString += property + ', ';
			}
			client.say(printString.substring(0, printString.length - 2));
		}

		//Handle a list of quotes including selecting a specific number, finding one based on search terms, and a random quote
		else if (commandName.match(/^!quotes/g)) {
			let sep = commandName.split(' ');
			let amount = parseInt(sep[1]);
			if (!isNaN(amount)) {
				if (quotes[amount - 1] != undefined) {
					client.say(`${quotes[amount - 1]}`);
				} else {
					client.say(`There aren't that many quotes.`)
				}
			} else if (sep[1] == 'find') {
				let search = '';
				for (let x = 2; x < sep.length; x++) {
					search += sep[x] + " ";
				}
				let searchResults = searchQuotes(search.trim());
				if (searchResults != undefined) {
					client.say(`${searchResults}`);
				} else {
					client.say('Quote not found.')
				}
			} else if (sep[1] == 'random') {
				let selection = rollDice(quotes.length) - 1;
				client.say(`${quotes[selection]}`);
			} else if (sep[1] == 'add' && privilegedUsers.includes(username)) {
				let quote = ' ';
				sep = chatter.message.split(' ');
				for (let x = 2; x < sep.length; x++) {
					quote += sep[x] + " ";
				}
				quotes.push(quote.trim());
				fs.writeFile('./config/quotes.json', arrayToString(quotes), (err) => {
					if (err) errorQueue.add(err.message);
				});
				statusQueue.add(`Added quote: ${quote}`);
			} else {
				client.say(`Type !quotes followed by either a number to select a quote number, random for a random quote, or find 'insert words here' to search for specific words.`);
			}
		}

		//If a user has endStreamThreshold points and typed !endstream confirm then endstream
		else if (commandName.match(/^!endstream/g)) {
			if (commandName == '!endstream confirm') {
				getPoints(username, (points) => {
					if (points.points >= endStreamThreshold) {
						client.say(`STREAM IS NOW ENDING`);
						removePoints(endStreamThreshold, username);
					} else {
						client.say(`${username}, you don't have enough points.`);
					}
				});
			} else {
				client.say(`Ending stream costs ${endStreamThreshold} points. Type !endstream confirm to end stream.`);
			}
		}

		//Tells how many points a user has
		else if (commandName == "!points") {
			getPoints(username, (points) => {
				if (points != undefined && points != null) {
					client.say(`${username} has ${points.points} points`);
				} else {
					client.say(`${username} has 0 points`);
				}
			})
		}

		//Gambles a given number of points by picking a random number between 1 and 100.
		else if (commandName.match(/^!gamble/g)) {
			let sep = commandName.split(' ');
			if (sep[1] != undefined) {
				if (sep[1] == 'all') {
					getPoints(username, (points) => {
						if (points >= 0) {
							let result = rollDice(1000);
							if (result == 1000) {
								addPoints(points * (jackpotMultiplier - 1), username);
								client.say(`${username} hit the jackpot and won ${points * jackpotMultiplier} points!`);
							} else if (result > 501) {
								addPoints(points, username);
								client.say(`${username} won ${points * normalWinMultiplier} points!`);
							} else {
								client.say(`${username} lost ${points} points`);
								removePoints(points, username);
							}
						} else {
							client.say(`${username}, you must gamble at least 1 point`);
						}
					});
				} else {
					let amount = parseInt(sep[1], 10);
					if (!isNaN(amount)) {
						getPoints(username, (points) => {
							if (amount <= points.points) {
								if (amount > 0) {
									let result = rollDice(1000);
									if (result == 1000) {
										addPoints(amount * (jackpotMultiplier - 1), username);
										client.say(`${username} hit the jackpot and won ${amount * jackpotMultiplier} points!`);
									} else if (result > 501) {
										addPoints(amount, username);
										client.say(`${username} won ${amount * normalWinMultiplier} points!`);
									} else {
										client.say(`${username} lost ${amount} points`);
										removePoints(amount, username);
									}
								} else {
									client.say(`${username}, you must gamble at least 1 point`);
								}
							} else {
								client.say(`${username} doesn't have enough points!`);
							}
						});
					} else {
						client.say(`Type !gamble followed by the number of points you want to gamble. A random number between 1 and 1000 will be rolled. If you get 1000, you win ${jackpotMultiplier}x your gambled points. If you get above 501, you ${normalWinMultiplier}x your gambled points. Any lower and you lose your points gambled.`);
					}
				}
			} else {
				client.say(`Type !gamble followed by the number of points you want to gamble. A random number between 1 and 1000 will be rolled. If you get 1000, you win ${jackpotMultiplier}x your gambled points. If you get above 501, you ${normalWinMultiplier}x your gambled points. Any lower and you lose your points gambled.`);
			}
		}

		//Tells who has the most points in stream
		else if (commandName == '!leaderboard') {
			getLeader((result) => {
				client.say(`${result.username} has the most points with ${result.points} points!`);
			});
		}

		//Checks the follow age of either the user that input the command if no-one is given or the user that is passed
		else if (commandName.match(/^!followage/g)) {
			let sep = commandName.split(' ');
			if (sep[1] != undefined) {
				getFollow(sep[1], (result) => {
					if (result.match('Error: User not found: ')) {
						client.say(`${sep[1]} isn't a user`);
					} else {
						client.say(result);
					}
				});
			} else {
				getFollow(username, (result) => {
					client.say(result);
				});
			}
		}

		//Lets users request songs for regularSongRequest points. It makes sure the song is 
		//under 5 minutes, is a valid youtube link
		//and it trys to auto confirm the video based on perameters such as views and like ratio
		else if (commandName.match(/^!songrequest/g)) {
			if (songsEnabled || username == botOwner) {
				let sep = commandName.split(' ');
				if (sep[1] != undefined) {
					getPoints(username, (points) => {
						if (points.points >= regularSongRequest) {
							insertSong(username, sep[1], shortSongLength, (result) => {
								if (result == 'successful') {
									client.say(`${username}, song added to queue`);
									removePoints(regularSongRequest, username);
								} else if (result == 'invalid') {
									client.say(`${username}, the given link is invalid. Only youtube links are allowed.`);
								} else if (result == 'exists') {
									client.say(`${username}, you can only have one song in the queue. Type !updatesong followed by the link to update your song request`);
								} else if (result == 'too long') {
									client.say(`${username}, songs must be less than 5 minutes in duration`);
								}
							});
						} else {
							client.say(`${username} doesn't have enough points`);
						}
					});
				} else {
					client.say(`Song requests cost ${regularSongRequest} points. Type !songrequest followed by a youtube to link to add your song to the queue. !songrequest
					is limited to 5 minutes. !extendedsongrequest is up to 10 minutes but costs ${longSongRequest} points.`);
				}
			} else {
				client.say(`Song requests are currently disabled`);
			}
		}

		//Lets users make extended song requests for longSongRequest points.
		else if (commandName.match(/^!extendedsongrequest/g)) {
			if (songsEnabled || username == botOwner) {
				let sep = commandName.split(' ');
				if (sep[1] != undefined) {
					getPoints(username, (points) => {
						if (points.points >= longSongRequest) {
							insertSong(username, sep[1], longSongLength, (result) => {
								if (result == 'successful') {
									client.say(`${username}, song added to queue`);
									removePoints(longSongRequest, username);
								} else if (result == 'invalid') {
									client.say(`${username}, the given link is invalid. Only youtube links are allowed.`);
								} else if (result == 'exists') {
									client.say(`${username}, you can only have one song in the queue. Type !updatesong followed by the link to update your song request`);
								} else if (result == 'too long') {
									client.say(`${username}, extended songs must be less than 10 minutes in duration`);
								}
							});
						} else {
							client.say(`${username} doesn't have enough points`);
						}
					});
				} else {
					client.say(`Extended song requests cost ${longSongRequest} points. Type !songrequest followed by a youtube to link to add your song to the queue.`);
				}
			} else {
				client.say(`Song requests are currently disabled`);
			}
		}

		//Updates a song request
		else if (commandName.match(/^!updatesong/g)) {
			let sep = commandName.split(' ');
			if (sep[1] != undefined) {
				updateSong(username, sep[1], longSongLength, (result) => {
					if (result == 'successful') {
						client.say(`${username}, song added to queue`);
					} else if (result == 'invalid') {
						client.say(`${username}, the given link is invalid. Only youtube links are allowed.`);
					} else if (result == 'not exist') {
						client.say(`${username}, you don't have a song in the queue. Type !songrequest followed by the link to submit your song request.`);
					} else if (result == 'too long') {
						client.say(`${username}, songs must be less than 5 minutes in duration`);
					}
				});
			} else {
				client.say(`Type !updatesong followed by a youtube to link to update your song.`);
			}
		}

		//Lets a super user confirm a song
		else if (commandName.match(/^!confirmsong/g) && superUsers.includes(username)) {
			let sep = commandName.split(' ');
			if (sep[1] != undefined) {
				confirmSong(sep[1]);
			} else {
				client.say(`A username must also be passed with !confirmsong`)
			}
		}

		//Returns a users position in the song request queue
		else if (commandName == '!queue') {
			getQueue((results) => {
				let inQueue = false;
				for (users in results) {
					if (results[users].username == username) {
						let conf;
						let spot = parseInt(users) + 1;
						let place = `${username}, your song is ${spot} in the queue.`;
						if (parseInt(results[users].confirmed) == 1) {
							conf = ` Your song is approved.`;
						} else {
							conf = ` Your song is not approved.`;
						}
						client.say(place + conf);
						inQueue = true;
					}
				}
				if (!inQueue) {
					client.say(`${username}, you don't have a song in the queue.`)
				}
			});
		}

		//Lists the current bet choices
		else if (commandName == '!betchoices') {
			if (betChoices[0] != undefined) {
				let message = 'Bet has options: '
				for (let y = 0; y < betChoices.length; y++) {
					message += `${parseInt(y) + 1}) ${betChoices[y]}, `;
				}
				client.say(message);
			} else {
				client.say(`There are no bet choices`);
			}
		}

		//Lets a user bet on a choice with the given number of points
		else if (commandName.match(/^!bet /g)) {
			if (betStart) {
				let sep = commandName.split(' ');
				let bet = parseInt(sep[1]);
				let choice = parseInt(sep[2]);
				if (!isNaN(bet) && !isNaN(choice)) {
					getPoints(username, (points) => {
						if (points.points >= bet) {
							if (bet > 0) {
								if (betChoices[choice - 1] != undefined) {
									addBet(username, bet, choice, (res) => {
										if (res == 'err') {
											client.say(`${username}, an error occured. Try again in a few minutes.`);
										} else if (res == 'success') {
											client.say(`${username}, bet added successfully`);
										}
									});
								} else {
									client.say(`${username}, that is not a valid bet choice. Type !betchoices to see the current choices.`);
								}
							} else {
								client.say(`${username}, you must bet at least 1 point`);
							}
						} else {
							client.say(`${username}, you don't have enough points.`)
						}
					});
				} else {
					client.say(`${username}, type !bet followed by 2 numbers. The first represents the bet amount while the second represents your bet choice.`)
				}
			} else {
				client.say(`${username}, no bets are taking place right now`);
			}
		}

		//Gets the users current bet amount and choice
		else if (commandName == '!getbet') {
			individualBet(username, (res) => {
				if (res != undefined) {
					client.say(`${username}, you have bet ${res.betamount} points on '${betChoices[res.betnum - 1]}'`);
				} else {
					client.say(`${username}, you don't have any bets`)
				}
			});
		}

		//Allows a user to change their bet choice
		//[TODO] Restrict choice changing
		/*
		else if (commandName.match('!changebet')){
			let sep = commandName.split(' ');
			let choice = parseInt(sep[1]);
			if (!isNaN(choice)){
				if (betChoices[choice - 1] != undefined){
					updateBet(username, choice);
					client.say(`${username}, bet choice updated.`);
				} else {
					client.say(`${username}, that is not a valid bet choice. Type !betchoices to see the current choices.`)
				}
			} else {
				client.say(`${username}, type !changebet followed by the number of your choice to update your bet`);
			}
		}
		*/

		//Lets a super user start a bet with the given choices
		else if (commandName.match(/^!startbet/g) && superUsers.includes(username)) {
			let sep = commandName.split(', ');
			refundBets(() => {
				wipeBets();
				betChoices = [];
				for (let x = 1; x < sep.length; x++) {
					betChoices[x - 1] = sep[x];
				}
				betStart = true;
				let message = 'Bet starting with options: '
				for (let y = 0; y < betChoices.length; y++) {
					message += `${parseInt(y) + 1}) ${betChoices[y]}, `;
				}
				client.say(message);
				fs.writeFile('./bets.txt', betChoices, (err) => {
					if (err) errorQueue.add(err.message);
				});
			});
		}

		//Disables betting
		else if (commandName == '!betoff' && superUsers.includes(username)) {
			betStart = false;
		}

		//Ends the bet and takes a choice as the winning choice
		else if (commandName.match(/^!betend/g) && superUsers.includes(username)) {
			let sep = commandName.split(' ');
			let winner = parseInt(sep[1]);
			if (!isNaN(winner)) {
				distributeWinnings(winner, () => {
					wipeBets();
				});
				fs.writeFile('bets.txt', '', (err) => {
					if (err) errorQueue.add(err.message);
				});
				betChoices = [];
				betStart = false;
				client.say(`Distributing points to everyone betting on ${betChoices[winner - 1]}`);
			}
		}

		//Enables song requests
		else if (commandName == '!enablesongs' && superUsers.includes(username)) {
			songsEnabled = true;
			client.say(`Song requests are now enabled`);
		}

		//Disables song requests
		else if (commandName == '!disablesongs' && superUsers.includes(username)) {
			songsEnabled = false;
			client.say(`Song requests are now disabled`);
		}

		//Gets the current status of song requests
		else if (commandName == '!songstatus') {
			if (songsEnabled) {
				client.say(`Songs are currently enabled`);
			} else {
				client.say(`Songs are currently disabled`);
			}
		}

		//Gets the next song in the queue if there is a confirmed song
		else if (commandName == '!nextsong' && superUsers.includes(username)) {
			getSong((result) => {
				if (result != undefined) {
					if (mqttSend) {
						sendSong(result.link);
						statusQueue.add(`[MQTT] Sending ${result.link} requested by ${result.username}`);
						removeSong(result.username);
					} else {
						client.say(`The next song link is: ${result.link}. Song was requested by ${result.username}`);
						removeSong(result.username);
					}
				} else {
					client.say(`There are no confirmed songs in the queue`);
				}
			});
		}

		//Removes a song from the queue given a username
		else if (commandName.match(/^!removesong/g) && superUsers.includes(username)) {
			let sep = commandName.split(' ');
			if (sep[1] != undefined) {
				removeSong(sep[1]);
			} else {
				client.say(`A username must also be passed with !removesong`)
			}
		}

		//Enables songs to be sent over mqtt
		else if (commandName.match(/^!mqttsongs/g) && superUsers.includes(username)) {
			mqttSend = true;
			client.say(`Songs are now being sent over mqtt`);
		}

		//Enables songs to be sent in chat
		else if (commandName.match(/^!chatsongs/g) && superUsers.includes(username)) {
			mqttSend = false;
			client.say(`Songs are now being sent in chat`);
		}

		//Echos the way songs are currently being sent
		else if (commandName.match(/^!sendingstatus/g) && superUsers.includes(username)) {
			if (mqttSend) {
				client.say(`Songs are being sent over mqtt`);
			} else {
				client.say(`Songs are being sent to chat`);
			}
		}

		//The message was randoms chatting so "reward" the user
		else {
			addPoints(1, username);
		}
	}

	//log the message
	const today = new Date();
	const time = `${today.getHours()}:${today.getMinutes()}:${today.getSeconds()}`;
	messageQueue.add(`[MESSAGE] ${username} typed '${chatter.message}' at ${time}`);
});

//On subscriptions thank the person that subbed
client.on('subscription', data => {
	const resub = data.msg_id;
	const user = data.login;

	if (resub == 'resub') {
		const months = data.msg_param_cumulative_months;
		messageQueue.add(`[SUB] Thanks for subscribing for ${months} months ${user}!`);
		client.say(`Thanks for resubscribing for ${months} months ${user}!`);
	}
	else {
		messageQueue.add(`[SUB] Thanks for subscribing ${user}!`)
		client.say(`Thanks for subscribing ${user}!`);
	}

});

//On an error, log the error then set handlingError to true
client.on('error', err => {
	if (!handlingError) {
		errorQueue.add(`[ERROR] ${err.message}`);
		handlingError = true;
	}
});

//When the connection is closed, log a message
client.on('close', () => {
	statusQueue.add('[CLOSED CONNECTION]');
});

//Gets the formatted time between 2 javascript times
function getFormattedTimeBetween(time) {
	let seconds = time / 1000;
	seconds = seconds.toFixed(0);
	if (seconds >= 60) {
		let minutes = Math.trunc(seconds / 60);
		seconds = seconds % 60;
		if (minutes >= 60) {
			let hours = Math.trunc(minutes / 60);
			minutes = minutes % 60;
			if (hours >= 24) {
				let days = Math.trunc(hours / 24);
				hours = hours % 24;
				return `${days} days, ${hours} hours, ${minutes} minutes, ${seconds} seconds`
			}
			else {
				return `${hours} hours, ${minutes} minutes, ${seconds} seconds`
			}
		}
		else {
			return `${minutes} minutes, ${seconds} seconds`
		}
	}
	else {
		return `${seconds} seconds`
	}
}

//Distributes points to users in chat
//For simplicity, this function also handles errors general
//errors with the twitch-bot class and restarts the bot 
//once it can make successful api calls
function distributePoints() {
	getData(`https://api.twitch.tv/helix/streams?user_login=${channelName}`, { 'headers': { 'Client-ID': twitchApi } })
		.then(res => res.json())
		.then(json => {
			if (json.data[0] != undefined) {
				getData(`https://tmi.twitch.tv/group/user/${channelName}/chatters`)
					.then(res => res.json())
					.then(json => {
						if (handlingError) {
							restartProcess();
						} else {
							isLive = true;
							for (viewer in json.chatters.vips) {
								addPoints(ppm, json.chatters.vips[viewer])
							}
							for (viewer in json.chatters.moderators) {
								addPoints(ppm, json.chatters.moderators[viewer])
							}
							for (viewer in json.chatters.viewers) {
								addPoints(ppm, json.chatters.viewers[viewer])
							}
							for (viewer in json.chatters.broadcaster) {
								addPoints(ppm, json.chatters.broadcaster[viewer]);
							}
						}
					})
					.catch(err => { errorQueue.add(`[ERROR] ${err.message}`); });
			} else {
				isLive = false;
			}
		})
		.catch(err => { errorQueue.add(`[ERROR] ${err.message}`); });
}

//Adds points of the given amount to the given user
function addPoints(amount, viewer) {
	let sql = `INSERT IGNORE INTO rev_db.users 
	SET username = '${viewer}', points = 0;`
	con.query(sql, function (create_err) {
		if (create_err) errorQueue.add(err.message);
		sql = `UPDATE rev_db.users SET points = points + ${amount} WHERE username = '${viewer}' AND EXISTS (SELECT username FROM rev_db.talked WHERE username = '${viewer}');`;
		con.query(sql, function (update_err) {
			if (update_err) errorQueue.add(err.message);
		});
	});
}

//Returns the points a given user has
function getPoints(viewer, cb) {
	let sql = `SELECT points FROM rev_db.users WHERE username = '${viewer}';`;
	con.query(sql, function (query_err, result) {
		if (query_err) errorQueue.add(err.message);
		cb(result[0]);
	});
}

//Rolls a dice between 1 and 100
function rollDice(sides) {
	return Math.floor(Math.random() * sides) + 1;
}

//Removes points based on the given amount and the given user
function removePoints(amount, viewer) {
	let sql = `INSERT IGNORE INTO rev_db.users 
	SET username = '${viewer}', points = 0;`
	con.query(sql, function (create_err) {
		if (create_err) errorQueue.add(err.message);
		sql = `UPDATE rev_db.users SET points = points - ${amount} WHERE username = '${viewer}';`;
		con.query(sql, function (update_err) {
			if (update_err) errorQueue.add(err.message);
		});
	});
}

//Returns the person with highest points and how many
function getLeader(cb) {
	let sql = `SELECT username, points FROM rev_db.users WHERE points = (SELECT MAX(points) FROM rev_db.users);`;
	con.query(sql, function (query_err, result) {
		if (query_err) errorQueue.add(err.message);
		cb(result[0]);
	});
}

//Makes and API call for the follow age of a give viewer
function getFollow(viewer, cb) {
	getData(`https://api.2g.be/twitch/followage/${channelName}/${viewer}`)
		.then(res => res.text())
		.then(body => {
			cb(body);
		})
		.catch(err => { errorQueue.add(`[ERROR] ${err.message}`); });
}

//Puts the given person in the talked table
function createTalked(viewer) {
	let sql = `INSERT IGNORE INTO rev_db.talked SET username = '${viewer}';`;
	con.query(sql, function (insert_err) {
		if (insert_err) errorQueue.add(err.message);
	});
}

//Inserts a given song into the songs DB if it passes the link criteria and is less than 5 minutes
//it then tries to autoconfirm the song based on predefined conditions such as views and like ration
function insertSong(viewer, link, length, cb) {
	let sql = `SELECT username FROM rev_db.song_requests WHERE username = '${viewer}';`;
	con.query(sql, function (query_user_err, query_user_result) {
		if (query_user_err) errorQueue.add(err.message);
		if (query_user_result[0] == undefined) {
			if (link.match('youtube.com') || link.match('youtu.be')) {
				confirmLength(link, length, (statistics) => {
					messageQueue.add(`[SONGS] ${statistics}`);
					if (statistics == 'invalid') {
						cb('invalid');
					} else if (statistics == 'too long') {
						cb('too long');
					} else {
						sql = "INSERT INTO `rev_db`.`song_requests` (`link`, `username`) VALUES ('" + link + "', '" + viewer + "');";
						con.query(sql, function (insert_err) {
							if (insert_err) errorQueue.add(err.message);
							else {
								autoConfirm(viewer, link);
								cb('successful');
							}
						});
					}
				});
			} else {
				cb('invalid');
			}
		} else {
			cb('exists');
		}
	});
}

//Returns the entire queue
function getQueue(cb) {
	let sql = `SELECT username, confirmed FROM rev_db.song_requests ORDER BY time;`
	con.query(sql, function (query_err, query_result) {
		if (query_err) errorQueue.add(err.message);
		cb(query_result);
	});
}

//Confirms the song of a given user
function confirmSong(viewer) {
	let sql = `UPDATE rev_db.song_requests SET confirmed = 1 WHERE username = '${viewer}';`;
	con.query(sql, function (update_err) {
		if (update_err) errorQueue.add(err.message);
	});
}

//Tries to auto confirm the song for a given link
function autoConfirm(viewer, link) {
	if (link.match('youtube.com')) {
		let sep1 = link.split('v=');
		let sep2 = sep1[1].split('&');
		getData(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${sep2[0]}&key=${googleAPI}`)
			.then(res => res.json())
			.then(json => {
				if (json.items[0] != undefined) {
					let statistics = json.items[0].statistics;
					let viewCount = parseInt(statistics.viewCount);
					let likes = parseInt(statistics.likeCount);
					let total = likes + parseInt(statistics.dislikeCount);
					messageQueue.add(`[YOUTUBE STATS] viewcount = ${viewCount} likes = ${likes} total votes = ${total}`);
					if (viewCount > requiredViewCount && (likes / total) > requiredLikePercentage) {
						confirmSong(viewer);
					}
				} else {
					cb('invalid');
				}
			})
			.catch(err => { errorQueue.add(`[ERROR] ${err.message}`); });
	} else if (link.match('youtu.be')) {
		link.replace('https://youtu.be/', '');
		getData(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${link}&key=${googleAPI}`)
			.then(res => res.json())
			.then(json => {
				if (json.items[0] != undefined) {
					let statistics = json.items[0].statistics;
					let viewCount = parseInt(statistics.viewCount);
					let likes = parseInt(statistics.likeCount);
					let total = likes + parseInt(statistics.dislikeCount);
					if (viewCount > requiredViewCount && (likes / total) > requiredLikePercentage) {
						confirmSong(viewer);
					}
				} else {
					cb('invalid');
				}
			})
			.catch(err => { errorQueue.add(`[ERROR] ${err.message}`); });
	}
}

//Updates the song in the DB for a given user then tries to autoconfirm the new song
function updateSong(viewer, link, cb) {
	let sql = `SELECT username FROM rev_db.song_requests WHERE username = '${viewer}'`;
	con.query(sql, function (query_user_err, query_user_result) {
		if (query_user_err) errorQueue.add(err.message);
		if (query_user_result[0] != undefined) {
			if (link.match('youtube.com') || link.match('youtu.be')) {
				sql = `UPDATE rev_db.song_requests SET confirmed = 0, link = '${link}' WHERE username = '${viewer}');`;
				con.query(sql, function (update_err) {
					if (update_err) errorQueue.add(err.message);
					else {
						autoConfirm(viewer, link);
						cb('successful');
					}
				});
			} else {
				cb('invalid');
			}
		} else {
			cb('not exists');
		}
	});
}

//Gets the next song in the DB that is confirmed
function getSong(cb) {
	let sql = `SELECT link, username FROM rev_db.song_requests WHERE confirmed = 1 ORDER BY time;`;
	con.query(sql, function (query_err, query_result) {
		if (query_err) errorQueue.add(err.message);
		cb(query_result[0]);
	});
}

//Removes the song of a given viewer
function removeSong(viewer) {
	let sql = `DELETE FROM rev_db.song_requests WHERE username = '${viewer}'`;
	con.query(sql, function (delete_err) {
		if (delete_err) errorQueue.add(err.message);
	});
}

//Confirms that a song lines up with length restrictions
function confirmLength(link, length, cb) {
	if (link.match('youtube.com')) {
		let sep1 = link.split('v=');
		let sep2 = sep1[1].split('&');
		getData(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&statistics&id=${sep2[0]}&key=${googleAPI}`)
			.then(res => res.json())
			.then(json => {
				if (json.items[0] != undefined) {
					let duration = json.items[0].contentDetails.duration;
					if (!duration.includes('H') && moment.duration(duration)._data.minutes <= length) {
						cb('good');
					} else {
						cb('too long');
					}
				} else {

					cb('invalid');
				}
			})
			.catch(err => { errorQueue.add(`[ERROR] ${err.message}`); });
	} else if (link.match('youtu.be')) {
		link.replace('https://youtu.be/', '');
		getData(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&statistics&id=${link}&key=${googleAPI}`)
			.then(res => res.json())
			.then(json => {
				if (json.items[0] != undefined) {
					let duration = json.items[0].contentDetails.duration;
					if (!duration.includes('H') && moment.duration(duration)._data.minutes <= length) {
						cb('good');
					} else {
						cb('too long');
					}
				} else {
					cb('invalid');
				}
			})
			.catch(err => { errorQueue.add(`[ERROR] ${err.message}`); });
	}
}

//Sends a song over mqtt
function sendSong(link) {
	mqttClient.publish('rev/songs', link);
}

//Gets the total bet amounts
function getBetAmounts(cb) {
	let sql = 'SELECT SUM(betamount) as total, betnum FROM rev_db.bets GROUP BY betnum;'
	con.query(sql, function (err, result) {
		if (err) errorQueue.add(err.message);
		else cb(result);
	});
}

//Adds a bet to the DB
function addBet(viewer, bet, choice, cb) {
	let sql = `INSERT IGNORE INTO rev_db.bets
	SET username = ?, betamount = 0, betnum = ?;`;
	con.query(sql, [
		viewer,
		choice
	], function (err) {
		if (err) errorQueue.add(err.message);
		sql = `UPDATE rev_db.bets SET betamount = betamount + ? WHERE username = ?;`;
		con.query(sql, [
			bet,
			viewer
		], function (err, result) {
			if (err) {
				cb('err')
				errorQueue.add(err.message);
			}
			else {
				removePoints(bet, viewer);
				cb('success');
			}
		});
	});
}

//Distributes bet winnings
function distributeWinnings(winning, cb) {
	let sql = `SELECT SUM(betamount) as total FROM rev_db.bets WHERE betnum <> ?;`;
	con.query(sql, [
		winning
	], function (lose_err, lose_result) {
		if (lose_err) errorQueue.add(err.message);
		sql = `SELECT betamount, username FROM rev_db.bets WHERE betnum = ?;`;
		con.query(sql, [
			winning
		], function (win_err, win_result) {
			if (win_err) errorQueue.add(err.message);
			let total = lose_result[0].total;
			let sum = 0;
			let percent;
			for (bet of win_result) {
				sum += parseInt(bet.betamount);
			}
			for (bet of win_result) {
				percent = parseInt(bet.betamount) / sum;
				addPoints((percent * total) + parseInt(bet.betamount), bet.username);
			}
			cb();
		});
	});
}

//Gets the bet for an individual user
function individualBet(viewer, cb) {
	let sql = `SELECT betamount, betnum FROM rev_db.bets WHERE username = ?;`;
	con.query(sql, [
		viewer
	], function (err, result) {
		if (err) errorQueue.add(err.message);
		cb(result[0]);
	});
}

//Updates the bet for a given user to a new choice
function updateBet(viewer, choice) {
	let sql = `UPDATE rev_db.bets SET betnum = ? WHERE username = ?;`;
	con.query(sql, [
		choice,
		viewer
	], function (err) {
		if (err) errorQueue.add(err.message);
	});
}

//Refunds all bets
function refundBets(cb) {
	let sql = `SELECT betamount, username FROM rev_db.bets;`
	con.query(sql, function (err, result) {
		if (err) errorQueue.add(err.message);
		for (bet of result) {
			addPoints(bet.betamont, bet.username);
		}
		cb();
	});
}

//Wipes the bets table
function wipeBets() {
	sql = `DELETE FROM rev_db.bets`;
	con.query(sql, function (err) {
		if (err) errorQueue.add(err.message);
	});
}

//Say a follow message from the json file if rev is live
function sayFollowMessage() {
	if (isLive) {
		let res = rollDice(followMessages.length) - 1;
		client.say(followMessages[res]);
	}
}

//Search quotes for a certain set of terms
function searchQuotes(search) {
	for (quote of quotes) {
		statusQueue.add(`${quote} might match ${search}`);
		if (quote.toLowerCase().match(search)) {
			return quote;
		}
	}
	return undefined;
}

//Convert an array to a string for writing to a file
function arrayToString(array) {
	let returnString = '['
	for (obj of array) {
		returnString += '"' + obj + '",'
	}
	returnString = returnString.replaceAt(returnString.length - 1, "]")
	return returnString;
}

//Add a function to replace parts of a string since it isn't defined by default
String.prototype.replaceAt = function (index, replacement) {
	return this.substr(0, index) + replacement + this.substr(index + replacement.length);
}

//Spawn a new process and kill the current process
function restartProcess() {
	errorQueue.add('[CRITICAL] Restarting process');
	const logfile = './daemon/';
	const out = fs.openSync(logfile, 'a');
	const err = fs.openSync(logfile, 'a');
	spawn(process.argv[0], process.argv.slice(1), {
		detached: true,
		stdio: ['ignore', out, err]
	}).unref();
	process.exit();
}