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
    
    public enqueueStart(track: SoundObject) {
        this.queue.unshift(track);
        this.skipTrack();
        void this.processQueue();
    }

    public enqueueShuffled(track: SoundObject) {
        // Pick a random spot to enqueue a shuffled item. Bias to pick the further of two random positions,
        // reducing the chance that a track plays multiple times in quick succession.
        const rand1 = Math.floor(Math.random() * (this.queue.length + 1));
        const rand2 = Math.floor(Math.random() * (this.queue.length + 1));
        const higher = Math.max(rand1, rand2);
        console.log(`Shuffle inserting track into position: ${higher}`);
        
        this.queue.splice(higher, 0, track);
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
        // Subtract 1 from start (since the queue visually indexes from 1). Don't subtract from the end since ranges are inclusive.
        skipStart -= 1; 
        if (skipStart === 0) 
            this.skipMultipleTracks(skipEnd);
        else if (skipStart < skipEnd) {
            for (let i = skipStart; i < skipEnd; i++) { console.log(`Skipping track #${i+1}: ${this.queue[i].title}`); }

            this.queue.splice(skipStart, skipEnd - skipStart);
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

        this.playbackFlags.shuffle = flag;
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
                        description: 'Cut the queue and play this track now?',
                        required: false,
                        choices: [ { name: 'yes', value: 'yes', }, { name: 'no', value: 'no', }]
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

    switch(interaction.commandName) {
        case 'play':    commandPlay(interaction, soundsmithConnection);    break;
        case 'skip':    commandSkip(interaction, soundsmithConnection);    break;
        case 'queue':   commandQueue(interaction, soundsmithConnection);   break;
        case 'pause':   commandPause(interaction, soundsmithConnection);   break;
        case 'resume':  commandResume(interaction, soundsmithConnection);  break;
        case 'leave':   commandLeave(interaction, soundsmithConnection);   break;
        case 'loop':    commandLoop(interaction, soundsmithConnection);    break;
        case 'shuffle': commandShuffle(interaction, soundsmithConnection); break;
        case 'repeat':  commandRepeat(interaction, soundsmithConnection);  break;
        default: await interaction.reply('Unknown command');
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
    await interaction.deferReply();

    // Extract the video URL from the command
    const url = interaction.options.get('url')!.value! as string;
    const now = interaction.options.get('now')?.value
    const enqueueAtStart = now && now === "yes";

    const user = interaction.user.username;

    // Join the user's voice channel if they are in one. 
    if (!soundsmithConnection) 
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

    // Check if the URL is a playlist.
    const listMatch = url.match(/^.*list=([^#\&\?]*).*/);
    if (listMatch && listMatch.length === 2 && listMatch[1].length > 0) {
        // Attempt to create multiple SoundObjects if the url is a playlist.
        try {
            const playlistId = listMatch[1];
            console.log(`Processing playlist id: ${playlistId}`);
            const playlist = await playdl.playlist_info(playlistId, { incomplete: true });
            
            if (playlist) {
                let videos = await playlist.all_videos();
                videos.forEach(video => { console.log(`Added track: ${video.title}, url: ${video.url} `) });

                // Create SoundObjects for every video retrievable from the playlist.
                for (let i = 0; i < videos.length; i++) {
                    const soundObject = await SoundObject.from(videos[i], user, {
                        onStart() { },
                        onFinish() { },
                        onError(error: any) {
                            console.warn(error);
                            interaction.followUp({ content: `Error: ${error.message}`, ephemeral: true }).catch(console.warn);
                        },
                    })
                    // Enqueue the track.
                    enqueueAtStart ? soundsmithConnection.enqueueStart(soundObject) : soundsmithConnection.enqueue(soundObject);
                }
                interaction.followUp({ content: `${videos.length} tracks have been added to the ${enqueueAtStart ? "front of the" : ""} queue.`});
            } else {
                console.log('No videos found in playlist, or invalid YouTube playlist.');
                interaction.followUp({ content: 'No videos found in playlist, or invalid YouTube playlist.'});
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
                    interaction.followUp({ content: `Error: ${error.message}`, ephemeral: true }).catch(console.warn);
                },
            })

            // Enqueue the track, and reply a success message to the user.
            enqueueAtStart ? soundsmithConnection.enqueueStart(soundObject) : soundsmithConnection.enqueue(soundObject);
            await interaction.followUp(`**${soundObject.title}** has been added to the ${enqueueAtStart ? "front of the" : ""}queue.`);

        // Something went wrong.
        } catch (error) {
            console.warn(error);
            await interaction.followUp(`Could not play the url: ${url}. Please verify the link is correct, or try again later.`);
        }
    }
}

/**
 * Skip track(s) in the Soundsmith queue.
 * Depends on user input. 
 *  - When given no parameters, skip the currently-playing track.
 *  - When given a single number, skip that many tracks, starting from the current track.
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
            let higher = Math.min(soundsmithConnection.queue.length, Math.max(first, second, 1));
            soundsmithConnection.skipRangeTracks(lower, higher);
    
            interaction.reply(`Skipped track${lower < higher ? `s: ${lower}-${higher}` : ` #${lower}`}.`);
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
    } else 
        await interaction.reply('Not playing in this server!');
}

/**
 * Display the current queue of tracks.
 * Shows the length of each track and the total length of the remaining queue.
 */
async function commandQueue(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        let current: string;
        if (soundsmithConnection.audioPlayer.state.status === AudioPlayerStatus.Idle)
            current = `Nothing is currently playing!`
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
        await interaction.reply('Not playing in this server!');
}

/**
 * Pause playback.
 */
async function commandPause(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        soundsmithConnection.audioPlayer.pause();
        await interaction.reply({ content: `Paused!`, ephemeral: true });
    } else 
        await interaction.reply('Not playing in this server!');
}

/**
 * Resume playback.
 */
async function commandResume(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        soundsmithConnection.audioPlayer.unpause();
        await interaction.reply({ content: `Unpaused!`, ephemeral: true });
    } else 
        await interaction.reply('Not playing in this server!');
}

/**
 * Cancel all sound and exit the voice channel.
 */
async function commandLeave(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        soundsmithConnection.voiceConnection.destroy();
        voiceConnections.delete(interaction.guildId);
        await interaction.reply({ content: `Goodbye world!`, ephemeral: true });
    } else 
        await interaction.reply('Not playing in this server!');
}

/**
 * Set the audio player's Loop flag.
 */
async function commandLoop(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const choice = interaction.options.get('flag')!.value! as string;
        console.log(`Loop: ${choice}`);
        await interaction.reply({ content: soundsmithConnection.setFlagLoop(choice === "on") ? "Loop enabled!" : "Loop disabled!", ephemeral: true });
    } else 
        await interaction.reply('Not playing in this server!');
}

/**
 * Set the audio player's Repeat flag.
 */
async function commandRepeat(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const choice = interaction.options.get('flag')!.value! as string;
        console.log(`Repeat: ${choice}`);
        await interaction.reply({ content: soundsmithConnection.setFlagRepeat(choice === "on") ? "Repeat enabled!" : "Repeat disabled!", ephemeral: true });
    } else 
        await interaction.reply('Not playing in this server!');
}

/**
 * Set the audio player's Shuffle flag.
 */
async function commandShuffle(interaction: CommandInteraction, soundsmithConnection: SoundsmithConnection) {
    if (soundsmithConnection) {
        const choice = interaction.options.get('flag')!.value! as string;
        console.log(`Shuffle: ${choice}`);
        await interaction.reply({ content: soundsmithConnection.setFlagShuffle(choice === "on") ? "Shuffle enabled!" : "Shuffle disabled!", ephemeral: true });
    } else 
        await interaction.reply('Not playing in this server!');
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