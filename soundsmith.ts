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
import { Interaction, Client, GuildMember, CommandInteraction, UserFlags } from 'discord.js';
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
    public currentObject: SoundObject | null;
    public skippedSong = false;

    public playbackFlags = {repeat: false, loop: false, shuffle: false};

    public constructor(voiceConnection: VoiceConnection) {
        this.voiceConnection = voiceConnection;
        this.audioPlayer = createAudioPlayer();
        this.queue = [];
        this.currentObject = null;

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
    
    public enqueueStart(track: SoundObject) {
        this.queue.unshift(track);
        void this.processQueue();
    }

    public skipTrack() {
        // Calling .stop() on an AudioPlayer causes it to transition into the Idle state. Because of a state transition
        // listener defined, transitions into the Idle state mean the next track from the queue will be loaded and played.
        this.skippedSong = true;
        this.audioPlayer.stop();
    }

    public skipMultipleTracks(numTracks: number) {
        if (numTracks > 1) {
            // Remove n-1 tracks and then use stop() to skip to the desired track.
            this.queue.splice(0, numTracks - 1);
        }
        this.skippedSong = true;
        this.audioPlayer.stop();
    }

    public skipRangeTracks(skipStart: number, skipEnd: number) {
        if (skipStart === 0) {
            this.skipMultipleTracks(skipEnd);
        } else if (skipStart < skipEnd) {
            this.queue.splice(skipStart, skipEnd);
        }
    }

    public setFlagRepeat(flag: boolean) {
        this.playbackFlags.repeat = flag;
        return flag; 
    }
    public setFlagLoop(flag: boolean) {
        this.playbackFlags.loop = flag;
        return flag;
    }
    public setFlagShuffle(flag: boolean) {
        if (flag) 
            this.shuffleQueue();

        this.playbackFlags.loop = flag;
        return flag;
    }

    private shuffleQueue() {
        // Optimized Durstenfeld shuffle 
        for (let i = this.queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i+1));
            [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        }
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
        //console.log(`Status: ${this.audioPlayer.state.status}, CurrentObject: ${this.currentObject?.title}, Flags (L,R,S): ${[this.playbackFlags.loop, this.playbackFlags.repeat, this.playbackFlags.shuffle]}`)

        // Return if the queue is locked (already being processed), or the audio player is already playing something
        if (this.queueLock || this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
            return;
        }

        // Return if the queue is empty and there's no repeating or looping track.
        if (this.queue.length === 0 && (!this.currentObject || !(this.playbackFlags.loop || this.playbackFlags.repeat))) {
            return;
        }

        // Lock the queue to guarantee safe access
        this.queueLock = true;

        // if (this.skippedSong) {
        //     this.skippedSong = false;
        // } else {
        //     if (this.playbackFlags.repeat && this.currentObject) {
        //         this.currentObject.onStart = noop;
        //         console.log(`Repeating song: ${this.currentObject.title}`);
        //     }
        //     else if (this.playbackFlags.loop && this.currentObject) {
        //         // Add the current track back to the end if we're looping the queue. 
        //         this.currentObject.onStart = noop;
        //         this.queue.unshift(this.currentObject);
        //     }
        // }

        // Use the previous object as the current object if repeating or if looping a single-track queue. Ignore this part if the last song was skipped.
        // Take the first item from the queue. This is guaranteed to exist, due to the non-empty check above.

        let nextTrack: SoundObject;

        if (!this.skippedSong && this.currentObject && (this.playbackFlags.repeat || (this.queue.length === 0 && this.playbackFlags.loop))) {
            nextTrack = this.currentObject.clearOnStart();
        } else {
            nextTrack = this.queue.shift()!;

            if (this.playbackFlags.loop && this.currentObject) {
                this.enqueue(this.currentObject);
                console.log(`Adding song to the end: ${this.currentObject.title}`);
            }
        }

        // const nextTrack = (!this.skippedSong && this.currentObject && (this.playbackFlags.repeat || (this.queue.length === 0 && this.playbackFlags.loop))) 
        //     ? this.currentObject.clearOnStart() 
        //     : this.queue.shift()!;

        this.skippedSong = false;

        try {
            // Attempt to convert the Track into an AudioResource (i.e., start to stream the video)
            const resource = await nextTrack.createAudioResource();
            resource.volume?.setVolumeLogarithmic(0.5);
            console.log(`Playing audio resource: ${nextTrack.title}`);

            this.currentObject = nextTrack; // Keep track of the currently playing object for loops
            this.audioPlayer.play(resource);
            this.queueLock = false;
        } catch (error) {
            // If an error occurred, play the next item of the queue instead.
            nextTrack.onError(error as Error);
            this.queueLock = false;
            return this.processQueue();
        }
    }
}

interface SoundObjectData {
    url: string;
    title: string;
    length: string;
    user: string;
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
    public readonly length: string;
    public readonly user: string;
    public onStart: () => void;
    public readonly onFinish: () => void;
    public readonly onError: (error: Error) => void;

    private constructor({ url, title, length, user, onStart, onFinish, onError}: SoundObjectData) {
        this.url = url;
        this.title = title;
        this.length = length;
        this.user = user;
        this.onStart = onStart;
        this.onFinish = onFinish;
        this.onError = onError;
    }

    public async createAudioResource() {
        const source = await playdl.stream(this.url, { discordPlayerCompatibility: true });
        return createAudioResource(source.stream, { metadata: this, inputType: source.type, inlineVolume: true });
    }

    /**
     * Remove the on-start reply trigger to the original command when starting the track.
     * This is called for when a track is looped or repeated, which doesn't need an acknowledgement/reply every time.
     */
    public clearOnStart() {
        this.onStart = noop;
        return this;
    }

    public getTimeHMS() {
        let lengthSeconds = parseInt(this.length);
        let hours = Math.floor(lengthSeconds / 3600);
        let minutes = Math.floor((lengthSeconds - (hours * 3600)) / 60);
        let seconds = lengthSeconds - (hours * 3600) - (minutes * 60);

        let strHours = hours.toString();
        let strMinutes = minutes.toString();
        let strSeconds = seconds.toString();
        if (hours < 10) { strHours = "0" + strHours; }
        if (minutes < 10) { strMinutes = "0" + strMinutes; }
        if (seconds < 10) { strSeconds = "0" + strSeconds; }
        return `${ hours > 0 ? strHours + ":" : ""}${strMinutes}:${strSeconds}`;
    }

    /**
     * Creates a SoundObject from a video URL and lifecycle callback methods.
     * 
     * @param url the URL of the video
     * @param methods Lifecycle callbacks
     * 
     * @returns the created track
     */
     public static async from(url: string, user: string, methods: Pick<SoundObject, 'onStart' | 'onFinish' | 'onError'>): Promise<SoundObject> {
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
            length: info.videoDetails.lengthSeconds,
            user: user,
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
            { name: 'play', description: 'Plays a song from a YouTube URL.',
                options: [
                    {
                        name: 'url',
                        type: 'STRING' as const,
                        description: 'The URL of the song to play',
                        required: true,
                    },
                ], 
            },
            { name: 'skip', description: 'Skip to the next song in the queue', 
                options: [
                    {
                        name: 'target',
                        type: 'STRING' as const,
                        description: 'Number of tracks to skip, or a specific range of tracks',
                        required: false,
                    },
                ],
            },
            { name: 'queue', description: 'Display the current music queue', },
            { name: 'pause', description: 'Pauses the currently playing song', },
            { name: 'resume', description: 'Resume playback of the current song', },
            { name: 'leave', description: 'Order Soundsmith to leave the voice channel', },
            { name: 'loop', description: 'Add finished songs back to the end of the queue.', 
                options: [
                    {
                        name: 'flag', 
                        type: 'STRING' as const, 
                        description: 'On or off', 
                        required: true, 
                        choices: [ { name: 'on', value: 'on', }, { name: 'off', value: 'off', }, ],
                    },
                ],
            },
            { name: 'shuffle', description: 'Randomize the order of songs played.', 
                options: [
                    {
                        name: 'flag', 
                        type: 'STRING' as const, 
                        description: 'On or off', 
                        required: true, 
                        choices: [ { name: 'on', value: 'on', }, { name: 'off', value: 'off', }, ],
                    },
                ],
            },
            { name: 'repeat', description: 'Repeat the currently playing song.', 
                options: [
                    {
                        name: 'flag', 
                        type: 'STRING' as const, 
                        description: 'On or off', 
                        required: true, 
                        choices: [ { name: 'on', value: 'on', }, { name: 'off', value: 'off', }, ],
                    },
                ],
            },
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

    } else if (interaction.commandName === 'loop') {
        commandLoop(interaction, soundsmithConnection);

    } else if (interaction.commandName === 'shuffle') {
        commandShuffle(interaction, soundsmithConnection);

    } else if (interaction.commandName === 'repeat') {
        commandRepeat(interaction, soundsmithConnection);

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
    const url = interaction.options.get('url')!.value! as string;
    const user = interaction.user.username;

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
        const soundObject = await SoundObject.from(url, user, {
            onStart() { },  //interaction.followUp({ content: `Now playing: ${soundObject.title}`, ephemeral: true }).catch(console.warn) }, // Spammy
            onFinish() { }, // Finish silently to reduce spam
            onError(error: any) {
                console.warn(error);
                interaction.followUp({ content: `Error: ${error.message}`, ephemeral: true }).catch(console.warn);
            },
        })

        // Enqueue the track, and reply a success message to the user.
        soundsmithConnection.enqueue(soundObject);
        await interaction.followUp(`**${soundObject.title}** has been added to the queue.`);

    // Something went wrong.
    } catch (error) {
        console.warn(error);
        await interaction.followUp(`Could not play the url: ${url}. Please verify the link is correct, or try again later.`);
    }
}

async function commandSkip(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const interactionOptions = interaction.options.get('target');

        if (!interactionOptions) {
            soundsmithConnection.skipTrack();
            await interaction.reply(`Skipped track: ${soundsmithConnection.currentObject?.title}`);
            return;
        }

        const target = interaction.options.get('target')!.value! as string;
        console.log(`Target: ${target}`);
        // Get mad if the user inputs anything that isn't digits or a hyphen
        if (target.match(/[^-\d]/)) {
            await interaction.reply('Your skip value must consist only of one number, or two numbers separated by a hyphen!')
            return;
        } 
        // Parse input to skip a range of tracks.
        const range = target.match(/(\d+)-(\d+)/);
        console.log(`Range: ${range}`);
        if (range && range.length === 3) {
            if (range[0] !== target) {
                await interaction.reply(`Something went wrong with your range: ${target}. Please try again.`);
                return;
            }

            let first = parseInt(range[1]);
            let second = parseInt(range[2]);
            let lower = Math.max(1, Math.min(first, second, soundsmithConnection.queue.length));
            let higher = Math.min(soundsmithConnection.queue.length, Math.max(first, second, soundsmithConnection.queue.length));
            soundsmithConnection.skipRangeTracks(lower, higher);
    
            if (lower < higher) {
                await interaction.reply(`Skipped tracks: ${lower}-${higher}.`);
            } else if (lower === higher) {
                await interaction.reply(`Skipped track #${lower}.`);
            }
            return;
        }
        // Parse input to skip n tracks (from the current).
        const number = Math.min(parseInt(target), soundsmithConnection.queue.length);
        console.log(`Number: ${number}`);
        if (number > 0) {
            soundsmithConnection.skipMultipleTracks(number);
            
            await interaction.reply(`Skipped ${number} tracks.`);
            return;
        } else {
            await interaction.reply('Please enter a positive number of tracks to skip.');
            return;
        }
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
            .map((song, index) => `${index + 1}. [${song.getTimeHMS()}] **${song.title}** Added by **${song.user}**`)
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
        await interaction.reply({ content: `Goodbye world!`, ephemeral: true });
    } else {
        await interaction.reply('Not playing in this server!');
    }
}

async function commandLoop(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const choice = interaction.options.get('flag')!.value! as string;
        console.log(`Loop: ${choice}`);

        await interaction.reply({ content: soundsmithConnection.setFlagLoop(choice === "on") ? "Loop enabled!" : "Loop disabled!", ephemeral: true });
    } else {
        await interaction.reply('Not playing in this server!');
    }
}

async function commandRepeat(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const choice = interaction.options.get('flag')!.value! as string;
        console.log(`Repeat: ${choice}`);

        await interaction.reply({ content: soundsmithConnection.setFlagRepeat(choice === "on") ? "Repeat enabled!" : "Repeat disabled!", ephemeral: true });
    } else {
        await interaction.reply('Not playing in this server!');
    }
}

async function commandShuffle(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const choice = interaction.options.get('flag')!.value! as string;
        console.log(`Repeat: ${choice}`);

        await interaction.reply({ content: soundsmithConnection.setFlagShuffle(choice === "on") ? "Shuffle enabled!" : "Shuffle disabled!", ephemeral: true });
    } else {
        await interaction.reply('Not playing in this server!');
    }
}