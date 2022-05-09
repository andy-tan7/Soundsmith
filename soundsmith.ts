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
import { Interaction, Client, GuildMember, CommandInteraction, ApplicationCommandData, ApplicationCommandOptionData, ApplicationCommandOptionChoice } from 'discord.js';
import playdl, { YouTubeVideo } from 'play-dl';
import dotenv from 'dotenv';

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};
const DISPLAY_QUEUE_MAX = 20;
const VOLUME_LOGARITHMIC = 0.5;

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
    
    /**
     * Add a track to the beginning of the queue and skip the current one.
     */
    public enqueueStart(track: SoundObject) {
        this.queue.unshift(track);
        this.skipTrack();
        void this.processQueue();
    }

    /**
     * Pick a random spot to enqueue a shuffled item. Bias to pick the further of two random positions,
     * lowering the chance that a track plays multiple times in quick succession.
     */
    public enqueueShuffled(track: SoundObject) {
        const rand1 = Math.floor(Math.random() * (this.queue.length + 1));
        const rand2 = Math.floor(Math.random() * (this.queue.length + 1));
        const higher = Math.max(rand1, rand2);
        console.log(`Shuffle inserting track into position: ${higher}`);
        
        this.queue.splice(higher, 0, track);
    }

    /**
     * Clear the queue and skip the current track. 
     */
    public stopQueue(): boolean {
        if (this.queue.length === 0)
            return false;

        this.queue.length = 0;
        this.skipTrack();
        return true;
    }

    /**
     * Skip functions. Skips can be done on a single track, multiple tracks, or a range of tracks.
     */
    public skipTrack() {
        // Calling .stop() on an AudioPlayer causes it to transition into the Idle state. Because of a state transition
        // listener defined, transitions into the Idle state mean the next track from the queue will be loaded and played.
        this.skippedSong = true;
        this.audioPlayer.stop();
    }
    public skipMultipleTracks(numTracks: number) {
        // Remove n-1 tracks from the queue and then use stop() to finally skip to the desired track.
        if (numTracks > 1) 
            this.queue.splice(0, numTracks - 1);
        this.skippedSong = true;
        this.audioPlayer.stop();
    }
    public skipRangeTracks(skipStart: number, skipEnd: number) {
        // If skipStart is 0, it means we're just skipping the first n tracks.
        if (skipStart === 0) {
            this.skipMultipleTracks(skipEnd + 1);
            return;
        }

        // Subtract 1 from start (queue visually indexes from 1), but prevent it from going negative
        skipStart = Math.max(0, skipStart - 1) 
        if (skipStart < skipEnd) {
            for (let i = skipStart; i < skipEnd; i++) { console.log(`Skipping track #${i+1}: ${this.queue[i].title}`); }
            this.queue.splice(skipStart, skipEnd - skipStart);
        }
    }

    /**
     * Flag setting for audio player states Repeat, Loop, and Shuffle
     * @returns True if the flag has changed, and false if it has not changed.
     */
    public setFlagRepeat(flag: boolean) {
        const prev = this.playbackFlags.repeat;
        this.playbackFlags.repeat = flag;
        return prev !== flag; 
    }
    public setFlagLoop(flag: boolean) {
        const prev = this.playbackFlags.loop;
        this.playbackFlags.loop = flag;
        return prev !== flag; 
    }
    /**
     * Turn Shuffle on or off. Shuffles the current queue when turned on.
     * @returns True if shuffling or if the shuffle flag is changing, 
     *          and false if attempting to turn it off when already off.
     */
    public setFlagShuffle(flag: boolean) {
        const prev = this.playbackFlags.shuffle;
        if (flag) 
            this.shuffleQueue();
        this.playbackFlags.shuffle = flag;
        return flag || flag !== prev;
    }

    /**
     * Optimized Durstenfeld shuffle 
     */
    private shuffleQueue() {
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

    public getQueueLength() {
        let totalTimeSeconds = 0;
        this.queue.forEach((entry) => totalTimeSeconds += entry.lengthSeconds);
        return calcTimeHMS(totalTimeSeconds);
    }

    /**
     * Attempts to play a SoundObject from the queue.
     */
    private async processQueue(): Promise<void> {
        // Return if the queue is locked (already being processed), or the audio player is already playing something
        if (this.queueLock || this.audioPlayer.state.status !== AudioPlayerStatus.Idle) 
            return;
        
        // Return if the queue is empty and there's no repeating or looping track.
        if (this.queue.length === 0 && (!this.currentObject || !(this.playbackFlags.loop || this.playbackFlags.repeat))) 
            return;
        
        this.queueLock = true; // Lock the queue to guarantee safe access

        let nextTrack: SoundObject;
        // Use the previous object as the current object if repeating or if looping a single-track queue.
        // Ignore this part if the last song was skipped.
        if (!this.skippedSong && this.currentObject && (this.playbackFlags.repeat || (this.queue.length === 0 && this.playbackFlags.loop))) {
            nextTrack = this.currentObject;
        } else {
            // Take the first item from the queue. This is guaranteed to exist, due to the non-empty check above.
            nextTrack = this.queue.shift()!;

            if (this.playbackFlags.loop && this.currentObject) {
                // Add the track back to a random position in the queue (biased toward further locations) if shuffle is enabled.
                this.playbackFlags.shuffle ? this.enqueueShuffled(this.currentObject) : this.enqueue(this.currentObject);
                console.log(`Adding song to the end: ${this.currentObject.title}`);
            }
        }
        this.skippedSong = false;

        try {
            const resource = await nextTrack.createAudioResource();
            resource.volume?.setVolumeLogarithmic(VOLUME_LOGARITHMIC);
            console.log(` * Now playing audio resource: ${nextTrack.title}`);

            // Keep track of the currently playing object for loops and repeats.
            this.currentObject = nextTrack; 
            this.audioPlayer.play(resource);
            this.queueLock = false;
        } catch (error) {
            // If an error occurred, try to play the next item of the queue instead.
            nextTrack.onError(error as Error);
            this.queueLock = false;
            return this.processQueue();
        }
    }
}

interface SoundObjectData {
    url: string;
    title: string;
    lengthSeconds: number;
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
    public readonly lengthSeconds: number;
    public readonly user: string;
    public onStart: () => void;
    public readonly onFinish: () => void;
    public readonly onError: (error: Error) => void;

    private constructor({ url, title, lengthSeconds, user, onStart, onFinish, onError}: SoundObjectData) {
        this.url = url;
        this.title = title;
        this.lengthSeconds = lengthSeconds;
        this.user = user;
        this.onStart = onStart;
        this.onFinish = onFinish;
        this.onError = onError;
    }

    public async createAudioResource() {
        const source = await playdl.stream(this.url, { discordPlayerCompatibility: true });
        return createAudioResource(source.stream, { metadata: this, inputType: source.type, inlineVolume: true });
    }

    public getTimeHMS() {
        return calcTimeHMS(this.lengthSeconds);
    }

    /**
     * Creates a SoundObject from a video URL and lifecycle callback methods.
     * 
     * @param info The video info
     * @param user The user who added this sound
     * @param methods Lifecycle callbacks
     * 
     * @returns the created track
     */
     public static async from(info: YouTubeVideo, user: string, methods: Pick<SoundObject, 'onStart' | 'onFinish' | 'onError'>): Promise<SoundObject> {

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
            title: info.title? info.title : "Untitled",
            lengthSeconds: info.durationInSec,
            user: user,
            url: info.url, 
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
                    {
                        name: 'now',
                        type: 'STRING' as const,
                        description: 'Cut ahead of the queue and play this track now?',
                        required: false,
                        choices: [ { name: 'yes', value: 'yes', }, { name: 'clear_queue', value: 'clear_queue', }, { name: 'no', value: 'no', }]
                    },
                ], 
            },
            { name: 'skip', description: 'Skip to the next song in the queue', 
                options: [
                    {
                        name: 'target',
                        type: 'STRING' as const,
                        description: 'Index of the track to skip, or a range of tracks to skip',
                        required: false,
                    },
                ],
            },
            { name: 'queue', description: 'Display the current music queue', },
            { name: 'stop', description: 'Clear the queue and stop playing sound', },
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
            generateAmbientOptions(),
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

    switch(interaction.commandName) {
        case 'play':    commandPlay(interaction, soundsmithConnection);    break;
        case 'skip':    commandSkip(interaction, soundsmithConnection);    break;
        case 'queue':   commandQueue(interaction, soundsmithConnection);   break;
        case 'stop':    commandStop(interaction, soundsmithConnection);    break;
        case 'pause':   commandPause(interaction, soundsmithConnection);   break;
        case 'resume':  commandResume(interaction, soundsmithConnection);  break;
        case 'leave':   commandLeave(interaction, soundsmithConnection);   break;
        case 'loop':    commandLoop(interaction, soundsmithConnection);    break;
        case 'shuffle': commandShuffle(interaction, soundsmithConnection); break;
        case 'repeat':  commandRepeat(interaction, soundsmithConnection);  break;
        case 'ambient': commandAmbient(interaction, soundsmithConnection); break;
        default: await interaction.reply({ content: 'Unknown command', ephemeral: true});
    }
})

// Slash command handlers

/**
 * Play a song from YouTube (standard). Needs to join a voice chat, which needs the user to be in one.
 * 
 * URLs can be either for a single YouTube video or for a playlist. URLs that include playlists will
 * default to loading the playlist contents into the queue.
 */
async function commandPlay(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {

    // Extract the video URL from the command
    const url = interaction.options.get('url')!.value! as string;
    const now = interaction.options.get('now')?.value
    const enqueueAtStart = (now && now === "yes") as boolean;
    const clearQueue = (now && now === "clear_queue") as boolean;

    const user = interaction.user.username;

    soundsmithConnection = tryJoinChannelOnCommand(interaction, soundsmithConnection);
    if (await userInVoiceAndConnectionStable(interaction, soundsmithConnection) === false) 
        return; 
    
    // Defer the reply, as finding the tracks may take more than the expected 3 seconds before responding.
    await interaction.deferReply();

    // Check if the URL is a playlist.
    const listMatch = url.match(/^.*list=([^#\&\?]*).*/);
    if (listMatch && listMatch.length === 2 && listMatch[1].length > 0) {
        try {
            // Attempt to create multiple SoundObjects if the url is a playlist.
            const playlistId = listMatch[1];
            const playlist = await playdl.playlist_info(playlistId, { incomplete: true });
            
            if (playlist) {
                let videos = await playlist.all_videos();
                videos.forEach(video => { console.log(`Added track: ${video.title}, url: ${video.url} `) });

                if (clearQueue) {
                    await interaction.followUp('Cleared the queue!');
                    soundsmithConnection.stopQueue();
                }
                // Create SoundObjects for every video retrievable from the playlist.
                for (let i = 0; i < videos.length; i++) {
                    const soundObject = await SoundObject.from(videos[i], user, {
                        onStart() { },
                        onFinish() { },
                        onError(error: any) {
                            console.warn(error);
                            interaction.followUp(`Error: ${error.message}`).catch(console.warn);
                        },
                    })

                    // Enqueue the track.
                    enqueueObject(soundsmithConnection, soundObject, enqueueAtStart);
                }
                interaction.followUp(`${videos.length} tracks have been added to the ${enqueueAtStart ? "front of the " : ""}queue.`);
            } else {
                console.warn('No videos found in playlist, or invalid YouTube playlist.');
                interaction.followUp('No videos found in playlist, or invalid YouTube playlist.');
            }
        } catch (error) {
            console.warn(error);
            await interaction.followUp(`Could not load playlist from the url: ${url}. Please verify the link is correct, or try again later.`);
        }
    } else {
        // Assume the url given is for a single video, since it is not a playlist.
        // Attempt to create a SoundObject from the user's video URL.
        try {
            const info = await playdl.video_info(url);
            const soundObject = await SoundObject.from(info.video_details, user, {
                onStart() { },  
                onFinish() { }, // Finish silently to reduce spam
                onError(error: any) {
                    console.warn(error);
                    interaction.followUp(`Error: ${error.message}`).catch(console.warn);
                },
            })
            if (clearQueue) {
                await interaction.followUp('Cleared the queue!');
                soundsmithConnection.stopQueue();
            }

            // Enqueue the track, and reply a success message to the user.
            enqueueObject(soundsmithConnection, soundObject, enqueueAtStart);
            await interaction.followUp(`**${soundObject.title}** has been added to the ${enqueueAtStart ? "front of the" : ""} queue.`);

        // Something went wrong.
        } catch (error) {
            console.warn(error);
            await interaction.followUp(`Could not play the url: ${url}. Please verify the link is correct, or try again later.`);
        }
    }
}

/**
 * Insert and play a preset ambient track based on the genre or theme given.
 */
 async function commandAmbient(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {

    const url = interaction.options.get('name')!.value! as string;
    const user = interaction.user.username;
    const clear = interaction.options.get('clear_queue')?.value
    const clearQueue = (clear && clear === "yes") as boolean;

    soundsmithConnection = tryJoinChannelOnCommand(interaction, soundsmithConnection);
    if (await userInVoiceAndConnectionStable(interaction, soundsmithConnection) === false) 
        return; 
    
    await interaction.deferReply();
    try {
        const info = await playdl.video_info(url);
        const soundObject = await SoundObject.from(info.video_details, user, {
            onStart() { },  
            onFinish() { }, // Finish silently to reduce spam
            onError(error: any) {
                console.warn(error);
                interaction.followUp(`Error: ${error.message}`).catch(console.warn);
            },
        })

        // Insert the track, and reply a success message to the user.
        if (clearQueue) {
            await interaction.followUp('Cleared the queue!');
            soundsmithConnection.stopQueue();
        }
        
        soundsmithConnection.enqueueStart(soundObject)
        await interaction.followUp(`Playing ambient track: **${soundObject.title}**`);

    // Something went wrong.
    } catch (error) {
        console.warn(error);
        await interaction.followUp(`Something went wrong with playing this ambient track. It may no longer exist.`);
    }
}

/**
 * Skip track(s) in the Soundsmith queue.
 * Depends on user input. 
 *  - When given no parameters, skip the currently-playing track.
 *  - When given a single number, skip the track with that index.
 *  - When given a range of numbers, remove that range of track numbers from the queue.
 */
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
            await interaction.reply({ content: 'Your skip value must consist only of one number, or two numbers separated by a hyphen!', ephemeral: true })
            return;
        } 

        // Parse input to skip a range of tracks.
        const range = target.match(/(\d+)-(\d+)/);
        console.log(`Range: ${range}`);
        if (range && range.length === 3) {
            if (range[0] !== target) {
                await interaction.reply({ content: `Something went wrong interpreting your range: ${target}. Please verify and try again.`, ephemeral: true });
                return;
            }

            let first = parseInt(range[1]);
            let second = parseInt(range[2]);
            let lower = Math.max(0, Math.min(first, second, soundsmithConnection.queue.length));
            let higher = Math.min(soundsmithConnection.queue.length, Math.max(first, second, 1));
            soundsmithConnection.skipRangeTracks(lower, higher);
    
            interaction.reply(`Skipped track${lower < higher ? `s: ${lower}-${higher}` : ` #${lower}`}.`);
            return;
        }

        // Parse input to skip a single track index.
        const number = Math.min(parseInt(target), soundsmithConnection.queue.length);
        console.log(`Number: ${number}`);
        if (number === 0) {
            soundsmithConnection.skipTrack();
            await interaction.reply(`Skipped track: ${soundsmithConnection.currentObject?.title}`);
            return;
        } else if (number > 0) {
            try {
                if (number <= soundsmithConnection.queue.length) {
                    const title = soundsmithConnection.queue[number - 1].title;
                    soundsmithConnection.skipRangeTracks(number, number);
                    await interaction.reply(`Skipped track #${number}: ${title}`);
                } else {
                    await interaction.reply({ content: `Please enter a track index that exists within the queue.`, ephemeral: true });
                }
            } catch (error) {
                console.warn(error);
                await interaction.followUp(`Something went wrong when trying to skip index #${number}.`);
            }
            return;
        } else {
            await interaction.reply({ content: 'Please enter a positive number for the index of the track to skip.', ephemeral: true });
            return;
        }
    } else 
        await interaction.reply({ content: 'Soundsmith is not playing in this server!', ephemeral: true });
}

/**
 * Display the current queue of tracks.
 * Shows the length of each track and the total length of the remaining queue.
 */
async function commandQueue(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        let current: string;
        if (soundsmithConnection.audioPlayer.state.status === AudioPlayerStatus.Idle) {
            await interaction.reply({ content: 'Nothing is currently playing!', ephemeral: true });
            return;
        }
        else {
            const playerInfo = (soundsmithConnection.audioPlayer.state.resource as AudioResource<SoundObject>);
            const metadata = playerInfo.metadata;
            current = `:arrow_forward: **\`[${calcTimeHMS(Math.floor(playerInfo.playbackDuration / 1000))} / ${metadata.getTimeHMS()}]\`** **__${metadata.title}__**  *added by ${metadata.user}*`;
        }
        
        let queue = soundsmithConnection.queue
            .slice(0, DISPLAY_QUEUE_MAX)
            .map((song, index) => `\`${index + 1}.\` \`${song.getTimeHMS()}\` *${song.user}:*  ${song.title}`)
            .join('\n');
        if (soundsmithConnection.queue.length > DISPLAY_QUEUE_MAX)
            queue = `${queue}\n\n...And ${soundsmithConnection.queue.length - DISPLAY_QUEUE_MAX} more tracks...`;
        
        await interaction.reply(`${current}\n${queue}\n**${soundsmithConnection.getQueueLength()}** total of queued tracks remaining.`);
    } else 
        await interaction.reply({ content: 'Soundsmith is not playing in this server!', ephemeral: true});
}

/**
 * Cancel all sound but stay in the voice channel.
 */
 async function commandStop(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const success = soundsmithConnection.stopQueue();
        if (success) {
            await interaction.reply('Stopped sounds and cleared the queue!');
        } else {
            await interaction.reply({ content: 'No tracks to stop!', ephemeral: true });
        }
    } else 
        await interaction.reply({ content: 'Soundsmith is not playing in this server!', ephemeral: true});
}

/**
 * Pause playback.
 */
async function commandPause(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const success = soundsmithConnection.audioPlayer.pause();
        if (success) { 
            await interaction.reply('Playback paused!');
        } else {
            await interaction.reply({ content: 'Soundsmith is already paused.', ephemeral: true});
        }
    } else 
        await interaction.reply({ content: 'Soundsmith is not playing in this server!', ephemeral: true});
}

/**
 * Resume playback.
 */
async function commandResume(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const success = soundsmithConnection.audioPlayer.unpause();
        if (success) { 
            await interaction.reply('Playback resumed!');
        } else {
            await interaction.reply({ content: 'Soundsmith is already playing.', ephemeral: true});
        }
    } else 
        await interaction.reply({ content: 'Soundsmith is not playing in this server!', ephemeral: true});
}

/**
 * Cancel all sound and exit the voice channel.
 */
async function commandLeave(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        soundsmithConnection.voiceConnection.destroy();
        voiceConnections.delete(interaction.guildId);
        await interaction.reply('Goodbye world!');
    } else 
        await interaction.reply({ content: 'Soundsmith is not playing in this server!', ephemeral: true});
}

/**
 * Set the audio player's Loop flag.
 */
async function commandLoop(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const flagOn = (interaction.options.get('flag')!.value! as string) === "on";
        const success = soundsmithConnection.setFlagLoop(flagOn);
        
        if (success) {
            await interaction.reply(`Loop ${ flagOn ? 'enabled' : 'disabled'}!`);
        } else {
            await interaction.reply({ content: `Loop is already ${flagOn ? 'enabled' : 'disabled'}.`, ephemeral: true});
        }
    } else 
        await interaction.reply({ content: 'Soundsmith is not playing in this server!', ephemeral: true});
}

/**
 * Set the audio player's Repeat flag.
 */
async function commandRepeat(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const flagOn = (interaction.options.get('flag')!.value! as string) === "on";
        const success = soundsmithConnection.setFlagRepeat(flagOn);

        if (success) {
            await interaction.reply(`Repeat ${ flagOn ? 'enabled' : 'disabled'}!`);
        } else {
            await interaction.reply({ content: `Repeat is already ${flagOn ? 'enabled' : 'disabled'}.`, ephemeral: true});
        }
    } else 
        await interaction.reply({ content: 'Soundsmith is not playing in this server!', ephemeral: true});
}

/**
 * Set the audio player's Shuffle flag.
 */
async function commandShuffle(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const flagOn = (interaction.options.get('flag')!.value! as string) === "on";
        const success = soundsmithConnection.setFlagShuffle(flagOn);

        if (success) {
            await interaction.reply(`Shuffle ${ flagOn ? 'enabled' : 'disabled'}!`);
        } else {
            await interaction.reply({ content: 'Shuffle is already disabled.', ephemeral: true});
        }
    } else 
        await interaction.reply({ content: 'Soundsmith is not playing in this server!', ephemeral: true});
}

// Helpers
function calcTimeHMS(lengthSeconds: number) {
    let hours = Math.floor(lengthSeconds / 3600);
    let minutes = Math.floor((lengthSeconds - (hours * 3600)) / 60);
    let seconds = lengthSeconds - (hours * 3600) - (minutes * 60);

    let strHours = hours.toString();
    let strMinutes = minutes.toString();
    let strSeconds = seconds.toString();
    if (hours > 0 && minutes < 10) { strMinutes = "0" + strMinutes; }
    if (seconds < 10) { strSeconds = "0" + strSeconds; }
    return `${ hours > 0 ? strHours + ":" : ""}${strMinutes}:${strSeconds}`;
}

function enqueueObject(soundsmithConnection: SoundsmithConnection, soundObject: SoundObject, enqueueAtStart: boolean) {
    enqueueAtStart ? soundsmithConnection.enqueueStart(soundObject) : soundsmithConnection.enqueue(soundObject);
}

/**
 * Try to join the user's voice channel if they are in one. Any command that plays music will need to do this.
 */
function tryJoinChannelOnCommand(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection): SoundsmithConnection {
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
    return soundsmithConnection;
}

/**
 * Tell the user to join a channel if they are not in one, and 
 * Ensure the connection is ready before processing the user's request. 
 * @returns boolean whether the connection is successful or not.
 */
async function userInVoiceAndConnectionStable(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection): Promise<boolean> {
    if (!soundsmithConnection) {
        await interaction.reply({ content: 'You must be in a voice channel first!', ephemeral: true});
        return false;
    }

    try {
        await entersState(soundsmithConnection.voiceConnection, VoiceConnectionStatus.Ready, 20e3);
    } catch (error) {
        console.warn(error);
        await interaction.reply('Failed to join voice channel after 20 seconds. Please try again later.');
        return false;
    }
    return true;
}

/**
 * @returns The array of preset ambient song options based on AMBIENT_RESOURCE.
 */
function generateAmbientOptions(): ApplicationCommandData {
    let stageOptions: ApplicationCommandOptionChoice[] = [];
    AMBIENT_RESOURCE.forEach(resource => {
        stageOptions.push({name: resource.name, value: resource.url});
    })

    return { name: 'ambient', description: 'Select a preset ambient sound to play.', options: [
        {
            name: 'name',
            type: 'STRING' as const,
            description: 'Preset',
            required: true,
            choices: stageOptions as ApplicationCommandOptionChoice[],
        },
        {
            name: 'clear_queue', 
            type: 'STRING' as const,
            description: 'Clear the whole playlist before playing this track',
            required: false,
            choices: [{ name: 'yes', value: 'yes', }, { name: 'no', value: 'no', }]
        },
    ]};
}

const AMBIENT_RESOURCE = [ // This list is limited to 25 due to Discord API limitations. I may add other commands in the future.
    { name: 'blacksmith',   url: 'https://www.youtube.com/watch?v=lxKVT1r4sgU', description: 'Ambient bellows'},
    { name: 'camp_night',   url: 'https://www.youtube.com/watch?v=LYF2VzCN0os', description: 'Cozy camp in the eerie night'},
    { name: 'camp_war',     url: 'https://www.youtube.com/watch?v=QP0hRjF4d6k', description: 'Sharpening blades and war preparations'},
    { name: 'city_crowd',   url: 'https://www.youtube.com/watch?v=_52K0E_gNY0', description: 'Loud, crowded medieval city'},
    { name: 'city_night',   url: 'https://www.youtube.com/watch?v=FvgV3G-EnnQ', description: 'Evening in the city'},
    { name: 'countryside',  url: 'https://www.youtube.com/watch?v=wEEc9RhHTzU', description: 'Calm countryside with animal sounds'},
    { name: 'cult_temple',  url: 'https://www.youtube.com/watch?v=UxOLopND4CA', description: 'Echoes and distant, evil chants'},
    { name: 'darkness',     url: 'https://www.youtube.com/watch?v=EUtE1k0VXKI', description: 'Echoes of the ruins below'},
    { name: 'deserted',     url: 'https://www.youtube.com/watch?v=2FpLYU8HoIo', description: 'The hollow remains of a ghost town'},
    { name: 'dungeon',      url: 'https://www.youtube.com/watch?v=wScEFaoqwPM', description: 'Cavernous hollows'},
    //{ name: 'forest_birds', url: 'https://www.youtube.com/watch?v=xNN7iTA57jM', description: 'Peaceful woodlands'},
    { name: 'forest_eerie', url: 'https://www.youtube.com/watch?v=QQg0br-eZUg', description: 'Uneasy woods'},
    { name: 'forest_wind',  url: 'https://www.youtube.com/watch?v=7WPsftkv1ZY', description: 'Soothing forest winds'},
    { name: 'hellish',      url: 'https://www.youtube.com/watch?v=JzVIkY5tKcE', description: 'Evil and haunting screams'},
    { name: 'library',      url: 'https://www.youtube.com/watch?v=VvC12NAf-Cw', description: 'Quiet library'},
    { name: 'mountain_wind', url: 'https://www.youtube.com/watch?v=oy0jX_I1CIU', description: 'Heavy, stable winds'},
    { name: 'ocean_cave',   url: 'https://www.youtube.com/watch?v=Z-pbILkmhMk', description: 'Cave by the ocean'},
    { name: 'ocean_shore',  url: 'https://www.youtube.com/watch?v=WcqURB6_E5I', description: 'Waves crash into jagged cliffs'},
    { name: 'rain',         url: 'https://www.youtube.com/watch?v=Mr9T-943BnE', description: 'Persistent showers'},
    { name: 'river',        url: 'https://www.youtube.com/watch?v=lR4GNWcwAI8', description: 'Down by the creek'},
    { name: 'storm_light',  url: 'https://www.youtube.com/watch?v=2wqf6nvML7Y', description: 'Mild thunderstorm'},
    //{ name: 'storm_heavy',  url: 'https://www.youtube.com/watch?v=KQ8MajN-61Q', description: 'Severe thunderstorm'},
    { name: 'tavern_lively', url: 'https://www.youtube.com/watch?v=KecVJnJcSI4', description: 'Crowded tavern'},
    { name: 'tavern_warm',  url: 'https://www.youtube.com/watch?v=rv3Nl-Od9YU', description: 'Cozy tavern with fireplace'},
    { name: 'underwater',   url: 'https://www.youtube.com/watch?v=NY3XkLe6oKQ', description: 'Echoes of the deep'},
    { name: 'wildfire',     url: 'https://www.youtube.com/watch?v=S3C1LfiLob8', description: 'Intense flames and things burning'},
    { name: 'wilderness_night', url: 'https://www.youtube.com/watch?v=ybTXj_OE4-k', description: 'The wilderness at night'},
]