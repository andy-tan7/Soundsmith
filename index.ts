import DiscordJS, { Client, VoiceChannel, Intents, Message } from 'discord.js';
import {
	joinVoiceChannel,
	createAudioPlayer,
	createAudioResource,
	entersState,
	StreamType,
	AudioPlayerStatus,
	VoiceConnectionStatus,
    DiscordGatewayAdapterCreator,
    getVoiceConnection,
    AudioResource,
} from '@discordjs/voice';
import dotenv from 'dotenv';
import ytdl from 'ytdl-core';
import fs from 'fs';

dotenv.config();

const prefix = "!";
const player = createAudioPlayer();

// Play a song or add it to the queue if another song is playing.
function playResource(audioResource: AudioResource) {
}

// Play a local music file (file validation already confirmed by caller)
function playLocal(filepath: string) {
    console.log(filepath);
    const resource = createAudioResource(filepath, {inputType: StreamType.Arbitrary});
    player.play(resource);

    return entersState(player, AudioPlayerStatus.Playing, 5e3);
}

// Stream audio from a YouTube URL.
function playYoutube(url: string) {

    const stream = ytdl(url, { filter: 'audioonly' });
    const resource = createAudioResource(stream);

    player.play(resource);
    return entersState(player, AudioPlayerStatus.Playing, 5e3);
}

// Join the caller's voice channel.
async function connectToChannel(channel: VoiceChannel) {
    const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
    });

    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 30e3);
        return connection;
    } catch (error) {
        connection.destroy();
        throw error;
    }
}

//---------------------------------------------------------------
// Create a new client and log it into Discord.
const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.GUILD_VOICE_STATES] });
client.login(process.env.TOKEN);
//---------------------------------------------------------------
// Client triggers
//---------------------------------------------------------------
client.on('ready', async () => {
    console.log('Discord.js client is ready!');

    try {
        console.log('Song is ready to play!');
    } catch (error) {
        console.error(error);
    }
});

// Message processing
client.on('messageCreate', async (message) => {
    if (!message.guild) return;

    // !join
    if (message.content === `${prefix}join`){
        CommandJoin(message);
        message.reply('Hello world!');

    // !playlocal
    } else if (message.content.startsWith(`${prefix}playlocal`)) {
        CommandPlayLocal(message);

    // !playweb
    } else if (message.content.startsWith(`${prefix}playweb`)) {
        CommandPlayWeb(message);
        
    // !stop
    } else if (message.content === `${prefix}stop`){
        CommandStop(message);
    }
});

//---------------------------------------------------------------
// Command message handlers
//---------------------------------------------------------------

// Join
async function CommandJoin(message: DiscordJS.Message): Promise<boolean> {
    const channel = message.member?.voice.channel;

    if (channel) {
        try {
            const connection = await connectToChannel(channel as VoiceChannel);
            connection.subscribe(player);
            return true;
        } catch (error) {
            console.error(error);
            return false;
        }
    } else {
        message.reply('Join a voice channel and try again!');
        return false;
    }
};

// Play Local
async function CommandPlayLocal(message: DiscordJS.Message) {
    if (message?.guild) {
        const connection = getVoiceConnection(message.guild.id);
        if (!connection)
            await CommandJoin(message);

        const args = message.content.split(" ");
        const trackname = __dirname.concat(`/tracks/${args[1]}`);
        fs.stat(trackname, function(err) {
            if (err) {
                console.log("File does not exist");
                message.reply(`Track "${args[1]}" not found.`);
            } else {
                console.log(`Playing local: ${args[1]}.`);
                playLocal(trackname);
            }
        })
    }
}

// Play Web
async function CommandPlayWeb(message: DiscordJS.Message) {
    if (message?.guild) {
        const connection = getVoiceConnection(message.guild.id);
        if (!connection)
            await CommandJoin(message);
        
        const args = message.content.split(" ");
        playYoutube(args[1]);
        message.reply(`Playing from web link: ${args[1]}.`);
    }
}

// Stop (Exit)
function CommandStop(message: DiscordJS.Message) {
    if (message?.guild) {
        const connection = getVoiceConnection(message.guild.id);
        if (connection){
            connection.destroy();
            message.reply('Goodbye world.');
        }
        else
            console.log("Don't need to leave any voice channels");
    }
}