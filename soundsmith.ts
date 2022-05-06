/**
 * Soundsmith is a Discord bot that plays music from YouTube or local data links.
 * In the future, it will also accept parameterized keywords to automatically fetch an appropriate tune for the description.
 */

import { 
    AudioPlayer,
    AudioPlayerStatus,
    createAudioPlayer, 
    createAudioResource, 
    AudioResource,
    DiscordGatewayAdapterCreator, 
    entersState, 
    joinVoiceChannel, 
    VoiceConnection, 
    VoiceConnectionStatus 
} from '@discordjs/voice';
import { Interaction, Client, GuildMember, CommandInteraction } from 'discord.js';
import { getInfo } from 'ytdl-core';
import playdl from 'play-dl';
import dotenv from 'dotenv';

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

/**
 * A SoundsmithConnection exists for each active VoiceConnection. Each connection has its own 
 * audio player and queue, and it also attaches logic to the audio player and voice connection.
 */
class SoundsmithConnection {
    public readonly voiceConnection: VoiceConnection;
    public readonly audioPlayer: AudioPlayer;
    public queue: SoundObject[];
    public queueLock = false;
    public readyLock = false;

    public constructor(voiceConnection: VoiceConnection) {
        this.voiceConnection = voiceConnection;
        this.audioPlayer = createAudioPlayer();
        this.queue = [];

        // Configure the audio player
        this.audioPlayer.on('stateChange', (oldState: any, newState: any) => {
            if (newState?.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
                // Non-idle becoming Idle means the previous audio resource has finished playing. 
				// The queue is then processed to start playing the next track, if one is available.
                (oldState.resource as AudioResource<SoundObject>).metadata.onFinish();
                void this.processQueue();
            } else if (newState.status === AudioPlayerStatus.Playing) {
				// If the Playing state has been entered, then a new track has started playback.
                (oldState.resource as AudioResource<SoundObject>).metadata.onStart();
            }
        });

        voiceConnection.subscribe(this.audioPlayer);
    }

    /**
     * Adds a new SoundObject to the queue.
     * 
     * @param track The track to add to the queue
     */
    public enqueue(track: SoundObject) {
        this.queue.push(track);
        void this.processQueue();
    }
    
    /**
     * Stops audio playback and empties the queue.
     */
    public stop() {
        this.queueLock = true;
        this.queue = [];
        this.audioPlayer.stop(true);
    }

    /**
     * Attempts to play a SoundObject from the queue.
     */
    private async processQueue(): Promise<void> {
        // Return if the queue is locked (already being processed), is empty, or the audio player is already playing something
        if (this.queueLock || this.audioPlayer.state.status !== AudioPlayerStatus.Idle || this.queue.length === 0) {
            return;
        }

        // Lock the queue to guarantee safe access
        this.queueLock = true;

        // Take the first item from the queue. This is guaranteed to exist, due to the non-empty check above.
        const nextTrack = this.queue.shift()!;
        try {
            // Attempt to convert the Track into an AudioResource (i.e., start to stream the video)
            const resource = await nextTrack.createAudioResource();
            console.log(`Playing audio resource: ${nextTrack.title}`);
            this.audioPlayer.play(resource);
            this.queueLock = false;
        } catch (error) {
            // If an error occurred, they the next item of the queue instead.
            nextTrack.onError(error as Error);
            this.queueLock = false;
            return this.processQueue();
        }
    }
}

interface SoundObjectData {
    url: string;
    title: string;
    onStart: () => void;
    onFinish: () => void;
    onError: (error: Error) => void;
}

/**
 * A SoundObject represents information about a YouTube video (in this context) that can be added to a queue.
 * It contains the title and URL of the video, as well as functions onStart, onFinish, onError, that act
 * as callbacks that are triggered at certain points during the track's lifecycle.
 *
 * Rather than creating an AudioResource for each video immediately and then keeping those in a queue,
 * we use objects as they don't pre-emptively load the videos. Instead, once a SoundObject is taken from the
 * queue, it is converted into an AudioResource just in time for playback.
 */
class SoundObject implements SoundObjectData {
    public readonly url: string;
    public readonly title: string;
    public readonly onStart: () => void;
    public readonly onFinish: () => void;
    public readonly onError: (error: Error) => void;

    private constructor({ url, title, onStart, onFinish, onError}: SoundObjectData) {
        this.url = url;
        this.title = title;
        this.onStart = onStart;
        this.onFinish = onFinish;
        this.onError = onError;
    }

    public async createAudioResource() {
        const source = await playdl.stream(this.url, { discordPlayerCompatibility: true });
        return createAudioResource(source.stream, { metadata: this, inputType: source.type });
    }

    /**
     * Creates a SoundObject from a video URL and lifecycle callback methods.
     * 
     * @param url the URL of the video
     * @param methods Lifecycle callbacks
     * 
     * @returns the created track
     */
     public static async from(url: string, methods: Pick<SoundObject, 'onStart' | 'onFinish' | 'onError'>): Promise<SoundObject> {
        const info = await getInfo(url);

        // The methods are wrapped so that we can ensure that they are only called once.
        const wrappedMethods = {
            onStart() {
                wrappedMethods.onStart = noop;
                methods.onStart();
            },
            onFinish() {
                wrappedMethods.onFinish = noop;
                methods.onFinish();
            },
            onError(error: Error) {
                wrappedMethods.onError = noop;
                methods.onError(error);
            }
        };

        return new SoundObject({
            title: info.videoDetails.title,
            url, 
            ...wrappedMethods,
        });
    }
}

const voiceConnections = new Map();
//---------------------------------------------------------------------------------------------
// Client setup
const client = new Client({ intents: ['GUILD_VOICE_STATES', 'GUILD_MESSAGES', 'GUILDS'] });
dotenv.config();
client.login(process.env.TOKEN);
client.once('ready', () => console.log('Discord.js client is ready.'));
//---------------------------------------------------------------------------------------------
// Client listeners

/**
 * The owner of the server can use !deploy to add Soundsmith's slash commands to the Discord server.
 */
client.on('messageCreate', async (message) => {
    if (!message.guild) return;
    if (!client.application?.owner) await client.application?.fetch();

    if (message.content.toLowerCase() === '!deploy' && message.author.id === client.application?.owner?.id) {
        await message.guild.commands.set([
            { name: 'play', description: 'Plays a song',
                options: [
                    {
                        name: 'song',
                        type: 'STRING' as const,
                        description: 'The URL of the song to play',
                        required: true,
                    },
                ], 
            },
            { name: 'skip', description: 'Skip to the next song in the queue', },
            { name: 'queue', description: 'Display the current music queue', },
            { name: 'pause', description: 'Pauses the currently playing song', },
            { name: 'resume', description: 'Resume playback of the current song', },
            { name: 'leave', description: 'Order Soundsmith to leave the voice channel', },
        ]);

        await message.reply('Deployed!');
    }
});

/**
 * Handle command interactions. 
 */
client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isCommand() || !interaction.guildId) return;
    let soundsmithConnection = voiceConnections.get(interaction.guildId);

    if (interaction.commandName === 'play') {
        commandPlay(interaction, soundsmithConnection);

    } else if (interaction.commandName === 'skip') {
        commandSkip(interaction, soundsmithConnection);

    } else if (interaction.commandName === 'queue') {
        commandQueue(interaction, soundsmithConnection);

    } else if (interaction.commandName === 'pause') {
        commandPause(interaction, soundsmithConnection);

    } else if (interaction.commandName === 'resume') {
        commandResume(interaction, soundsmithConnection);

    } else if (interaction.commandName === 'leave') {
        commandLeave(interaction, soundsmithConnection);

    } else {
        await interaction.reply('Unknown command');
    }
})

// Slash command handlers

/**
 * Play a song from YouTube (standard). Needs to join a voice chat, which needs the user to be in one.
 */
async function commandPlay(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    await interaction.deferReply();

    // Extract the video URL from the command
    const url = interaction.options.get('song')!.value! as string;

    // Join the user's voice channel if they are in one. 
    if (!soundsmithConnection) {
        if (interaction.member instanceof GuildMember && interaction.member.voice.channel) {
            let userChannel = interaction.member.voice.channel;

            soundsmithConnection = new SoundsmithConnection(
                joinVoiceChannel({
                    channelId: userChannel.id, 
                    guildId: userChannel.guildId, 
                    adapterCreator: userChannel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator
                })
            );

            soundsmithConnection.voiceConnection.on('error', console.warn);
            voiceConnections.set(interaction.guildId, soundsmithConnection);
        }
    }

    // Tell the user to join a channel if they are not in one. 
    if (!soundsmithConnection) {
        await interaction.followUp('You must be in a voice channel first!');
        return;
    }

    // Ensure the connection is ready before processing the user's request. 
    try {
        await entersState(soundsmithConnection.voiceConnection, VoiceConnectionStatus.Ready, 20e3);
    } catch (error) {
        console.warn(error);
        await interaction.followUp('Failed to join voice channel after 20 seconds. Please try again later.');
        return;
    }

    // Attempt to create a SoundObject from the user's video URL.
    try {
        const soundObject = await SoundObject.from(url, {
            onStart() { interaction.followUp({ content: 'Playing!', ephemeral: true }).catch(console.warn) },
            onFinish() { interaction.followUp({ content: 'Finished!', ephemeral: true }).catch(console.warn) },
            onError(error: any) {
                console.warn(error);
                interaction.followUp({ content: `Error: ${error.message}`, ephemeral: true }).catch(console.warn);
            },
        })

        // Enqueue the track, and reply a success message to the user.
        soundsmithConnection.enqueue(soundObject);
        await interaction.followUp(`Enqueued **${soundObject.title}**`);

    // Something went wrong.
    } catch (error) {
        console.warn(error);
        await interaction.followUp('Could not play. Please verify the link is correct, or try again later.');
    }
}

async function commandSkip(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        // Calling .stop() on an AudioPlayer causes it to transition into the Idle state. Because of a state transition
        // listener defined in music/subscription.ts, transitions into the Idle state mean the next track from the queue
        // will be loaded and played.
        soundsmithConnection.audioPlayer.stop();
        await interaction.reply('Skipped song!');
    } else {
        await interaction.reply('Not playing in this server!');
    }
}

async function commandQueue(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    // Print out the current queue (up to 20).
    if (soundsmithConnection) {
        const current = soundsmithConnection.audioPlayer.state.status === AudioPlayerStatus.Idle
            ? `Nothing is currently playing!`
            : `Playing **${(soundsmithConnection.audioPlayer.state.resource as AudioResource<SoundObject>).metadata.title}**`;
        
        const queue = soundsmithConnection.queue
            .slice(0, 20)
            .map((song, index) => `${index + 1} ${song.title}`)
            .join('\n');

        await interaction.reply(`${current}\n\n${queue}`);
    } else {
        await interaction.reply('Not playing in this server!');
    }
}

async function commandPause(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        soundsmithConnection.audioPlayer.pause();
        await interaction.reply({ content: `Paused!`, ephemeral: true });
    } else {
        await interaction.reply('Not playing in this server!');
    }
}

async function commandResume(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        soundsmithConnection.audioPlayer.unpause();
        await interaction.reply({ content: `Unpaused!`, ephemeral: true });
    } else {
        await interaction.reply('Not playing in this server!');
    }
}

async function commandLeave(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        soundsmithConnection.voiceConnection.destroy();
        voiceConnections.delete(interaction.guildId);
        await interaction.reply({ content: `Left channel!`, ephemeral: true });
    } else {
        await interaction.reply('Not playing in this server!');
    }
}