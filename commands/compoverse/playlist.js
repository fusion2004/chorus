const { Command } = require('discord.js-commando');

const { partyService } = require('../../lib/party');

module.exports = class PlaylistCommand extends Command {
  constructor(client) {
    super(client, {
      name: 'playlist',
      aliases: [],
      group: 'compoverse',
      memberName: 'playlist',
      description: 'Lists all songs in the listening party, highlighting where we are',
      guildOnly: true,
    });
  }

  async run(message) {
    let currentStream = partyService.state.context.stream.manager;
    if (!currentStream || currentStream.stopped) {
      message.reply('there is no listening party, currently!');
      return;
    }

    let { current, songs } = currentStream.roundManager;

    let msg = '';
    songs.forEach((song, index) => {
      if (current && current.song.id === song.id) {
        msg = msg.concat('**');
      }
      msg = msg.concat(`${index + 1}. ${song.safeTitle}`);
      if (current && current.song.id === song.id) {
        msg = msg.concat('**');
      }
      msg = msg.concat('\n');
    });

    message.say(msg);
  }
};
