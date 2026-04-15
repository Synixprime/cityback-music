require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { SpotifyApi } = require('@spotify/web-api-ts-sdk');
const ytSearch = require('yt-search');
const ytdl = require('@distube/ytdl-core');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Queue par serveur : Map<guildId, { tracks, player, connection, current }>
const queues = new Map();

// Initialisation Spotify SDK
const spotify = SpotifyApi.withClientCredentials(
  process.env.SPOTIFY_CLIENT_ID,
  process.env.SPOTIFY_CLIENT_SECRET
);

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    queues.set(guildId, { tracks: [], player: null, connection: null, current: null });
  }
  return queues.get(guildId);
}

async function searchYouTube(query) {
  const result = await ytSearch(query);
  return result.videos[0] || null;
}

async function playNext(guildId, textChannel) {
  const queue = getQueue(guildId);
  if (queue.tracks.length === 0) {
    queue.current = null;
    textChannel.send('✅ File d\'attente terminée ! Le bot quitte le salon vocal dans 30s d\'inactivité.');
    setTimeout(() => {
      if (queue.tracks.length === 0 && queue.connection) {
        queue.connection.destroy();
        queues.delete(guildId);
      }
    }, 30000);
    return;
  }

  const track = queue.tracks.shift();
  queue.current = track;

  try {
    const stream = ytdl(track.url, {
      filter: 'audioonly',
      quality: 'highestaudio',
      highWaterMark: 1 << 25,
    });

    const resource = createAudioResource(stream);
    queue.player.play(resource);
    textChannel.send(`🎵 **En cours :** ${track.title} — \`${track.duration}\``);
  } catch (err) {
    console.error('Erreur lecture :', err);
    textChannel.send(`❌ Impossible de lire **${track.title}**, passage au suivant...`);
    playNext(guildId, textChannel);
  }
}

// ──────────────────────────────────────────────
// Extraction des pistes Spotify
// ──────────────────────────────────────────────

async function resolveSpotifyUrl(url) {
  const playlistMatch = url.match(/playlist\/([a-zA-Z0-9]+)/);
  const trackMatch    = url.match(/track\/([a-zA-Z0-9]+)/);
  const albumMatch    = url.match(/album\/([a-zA-Z0-9]+)/);

  let tracks = [];

  if (playlistMatch) {
    const id = playlistMatch[1];
    let offset = 0;
    while (true) {
      const res = await spotify.playlists.getPlaylistItems(id, undefined, undefined, 50, offset);
      const items = res.items.filter(i => i.track && i.track.name);
      tracks.push(...items.map(i => `${i.track.artists[0].name} ${i.track.name}`));
      if (res.items.length < 50) break;
      offset += 50;
    }
  } else if (albumMatch) {
    const id = albumMatch[1];
    const res = await spotify.albums.tracks(id, undefined, 50);
    tracks = res.items.map(t => `${t.artists[0].name} ${t.name}`);
  } else if (trackMatch) {
    const id = trackMatch[1];
    const t = await spotify.tracks.get(id);
    tracks = [`${t.artists[0].name} ${t.name}`];
  }

  return tracks;
}

// ──────────────────────────────────────────────
// Gestion des messages
// ──────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const prefix = process.env.PREFIX || '!';
  if (!message.content.startsWith(prefix)) return;

  const args    = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ── !play <url spotify> ──────────────────────
  if (command === 'play') {
    const input = args.join(' ');
    if (!input) return message.reply('❌ Donne-moi une URL Spotify ou un nom de chanson !\nEx : `!play https://open.spotify.com/playlist/...`');

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply('❌ Tu dois être dans un salon vocal !');

    const queue = getQueue(message.guild.id);

    // Connexion vocale
    if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed) {
      queue.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });

      queue.player = createAudioPlayer();
      queue.connection.subscribe(queue.player);

      queue.player.on(AudioPlayerStatus.Idle, () => {
        playNext(message.guild.id, message.channel);
      });

      queue.player.on('error', (err) => {
        console.error('Player error:', err);
        playNext(message.guild.id, message.channel);
      });
    }

    // Résolution Spotify ou recherche directe
    const loadingMsg = await message.reply('🔍 Récupération des pistes Spotify...');

    let queries = [];
    if (input.includes('spotify.com')) {
      try {
        queries = await resolveSpotifyUrl(input);
      } catch (e) {
        console.error(e);
        return loadingMsg.edit('❌ Impossible de lire ce lien Spotify. Vérifie qu\'il est public.');
      }
    } else {
      queries = [input];
    }

    if (queries.length === 0) return loadingMsg.edit('❌ Aucune piste trouvée dans ce lien Spotify.');

    await loadingMsg.edit(`⏳ Recherche YouTube pour **${queries.length}** piste(s)... (peut prendre quelques secondes)`);

    // Recherche YouTube pour chaque titre (par batch pour ne pas spam)
    let added = 0;
    for (const q of queries) {
      const video = await searchYouTube(q);
      if (video) {
        queue.tracks.push({ title: video.title, url: video.url, duration: video.timestamp });
        added++;
      }
    }

    if (added === 0) return loadingMsg.edit('❌ Aucune vidéo YouTube trouvée pour ces pistes.');

    await loadingMsg.edit(`✅ **${added}** piste(s) ajoutée(s) à la file d'attente !`);

    // Démarre la lecture si rien ne joue
    if (!queue.current) {
      playNext(message.guild.id, message.channel);
    }
  }

  // ── !skip ────────────────────────────────────
  else if (command === 'skip') {
    const queue = getQueue(message.guild.id);
    if (!queue.player || !queue.current) return message.reply('❌ Rien ne joue en ce moment.');
    queue.player.stop();
    message.reply('⏭️ Piste suivante !');
  }

  // ── !pause ───────────────────────────────────
  else if (command === 'pause') {
    const queue = getQueue(message.guild.id);
    if (!queue.player) return message.reply('❌ Rien ne joue.');
    queue.player.pause();
    message.reply('⏸️ Musique en pause.');
  }

  // ── !resume ──────────────────────────────────
  else if (command === 'resume') {
    const queue = getQueue(message.guild.id);
    if (!queue.player) return message.reply('❌ Rien ne joue.');
    queue.player.unpause();
    message.reply('▶️ Reprise de la lecture !');
  }

  // ── !stop ────────────────────────────────────
  else if (command === 'stop') {
    const queue = getQueue(message.guild.id);
    queue.tracks = [];
    queue.current = null;
    if (queue.player) queue.player.stop();
    if (queue.connection) queue.connection.destroy();
    queues.delete(message.guild.id);
    message.reply('⏹️ Lecture arrêtée et file d\'attente vidée.');
  }

  // ── !queue ───────────────────────────────────
  else if (command === 'queue' || command === 'q') {
    const queue = getQueue(message.guild.id);
    if (!queue.current && queue.tracks.length === 0) return message.reply('📭 La file d\'attente est vide.');

    const lines = [];
    if (queue.current) lines.push(`🎵 **En cours :** ${queue.current.title}`);
    if (queue.tracks.length > 0) {
      lines.push(`\n**File d'attente (${queue.tracks.length} pistes) :**`);
      queue.tracks.slice(0, 10).forEach((t, i) => lines.push(`\`${i + 1}.\` ${t.title}`));
      if (queue.tracks.length > 10) lines.push(`... et ${queue.tracks.length - 10} autres pistes.`);
    }
    message.reply(lines.join('\n'));
  }

  // ── !help ────────────────────────────────────
  else if (command === 'help') {
    message.reply([
      '🎵 **Commandes du bot musique :**',
      '`!play <url spotify / nom>` — Joue une playlist, album ou chanson Spotify',
      '`!skip` — Passe à la piste suivante',
      '`!pause` — Met en pause',
      '`!resume` — Reprend la lecture',
      '`!stop` — Arrête et vide la file',
      '`!queue` — Affiche la file d\'attente',
    ].join('\n'));
  }
});

client.once('ready', () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
