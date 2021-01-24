const { Command } = require('discord.js-commando');
const { MessageEmbed } = require('discord.js');

const { store, streamUpdater } = require('../../lib/chorus-store');
const StreamManager = require('../../lib/stream_manager');

function formatDuration(durationInSeconds) {
  let minutes = Math.floor(durationInSeconds / 60);
  let seconds = `${Math.floor(durationInSeconds % 60)}`;

  return `${minutes}:${seconds.padStart(2, '0')}`;
}

module.exports = class StartPartyCommand extends Command {
  constructor(client) {
    super(client, {
      name: 'startparty',
      aliases: ['party'],
      group: 'compoverse',
      memberName: 'startparty',
      description: 'Starts a listening party for a Compo round',
      guildOnly: true,
      args: [
        {
          key: 'round',
          prompt: 'What round would you like to start a party for?',
          type: 'string'
        },
        {
          key: 'initialSongIndex',
          prompt: 'What\'s the index of the song we should start on?',
          type: 'integer',
          default: 0
        }
      ]
    });
  }

  async run(message, { round, initialSongIndex }) {
    let currentStream = store.state.context.stream.manager;
    if (currentStream && !currentStream.stopped) {
      message.reply('there is currently a listening party streaming. We can only stream one at a time.');
      return;
    }

    round = round.toUpperCase();
    let streamManager = new StreamManager(round, initialSongIndex);
    // TODO: this likely should be updated to message, not channel
    store.send(streamUpdater.update({ manager: streamManager, channel: message.channel }));

    streamManager.on('intro', function() {
      message.say('**Playing stream intro before we get this party started...**');
    });

    streamManager.on('playing', function(current) {
      let { song } = current;
      let length = formatDuration(song.metadata.format.duration);
      let position = current.index + 1;

      const embed = new MessageEmbed()
        .setColor('#39aa6e')
        .setTitle(song.safeTitle)
        .setDescription(`Entry ${position} of ${current.total}`)
        .addField('Artist', song.safeArtist)
        .addField('Length', length);

      message.say(`Now Playing: ${song.safeTitle} by ${song.safeArtist} [${length}]`);
      message.embed(embed);
    });

    streamManager.on('compoMetadataFetching', function() {
      message.say(`*Gathering round ${round} metadata...*`);
    });
    streamManager.on('fetchingSongs', function() {
      message.say(`*Downloading ${round} songs...*`);
    });
    streamManager.on('transcodingSongs', function() {
      message.say(`*Transcoding ${round} songs for streaming...*`);
    });
    streamManager.on('generatingAnnouncer', function() {
      message.say('*Clearing throat, performing vocal exercises...*');
    });

    streamManager.on('finish', () => {
      this.client.user.setActivity('the stars...', { type: 'WATCHING'});
      message.say('**The stream is concluded. See you next time!**');
    });

    streamManager.on('startingStream', function() {
      message.say(`**Starting stream... ${streamManager.streamUrl()}**`);
    });

    this.client.user.setActivity(`in #${message.channel.name}`);
    await streamManager.start().catch((error) => {
      streamManager.stop();
      throw error;
    });
  }
};
