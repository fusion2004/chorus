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
    let { currentSong, nextSongId, songs } = partyService.state.context;
    if (partyService.state.matches('idle')) {
      message.reply('there is no listening party, currently!');
      return;
    } else if (!songs || songs.length === 0) {
      message.reply("there aren't any songs fetched in the listening party, yet!");
      return;
    }

    let msg = '';
    songs.forEach((song, index) => {
      if (currentSong && currentSong.id === song.id) {
        msg = msg.concat(':arrow_forward: ');
      }
      if (nextSongId && nextSongId === song.id) {
        msg = msg.concat(':track_next: ');
      }
      msg = msg.concat(`${index + 1}. ${song.safeTitle} [`);
      if (song.formattedDuration) {
        msg = msg.concat(`length: ${song.formattedDuration}, `);
      }
      msg = msg.concat(`state: ${song.service.state.value}]`);
      msg = msg.concat('\n');
    });

    message.say(msg);
  }
};
