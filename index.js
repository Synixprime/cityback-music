require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
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

// Queue par serveur
const queues = new Map();

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
    textChannel.send('✅ File d\'attente terminée ! Le bot quitte le salon vocal dans 30s.');
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
// Scraping Spotify sans API
// ──────────────────────────────────────────────

async function resolveSpotifyUrl(url) {
  // On récupère la page HTML de Spotify et on extrait les titres depuis les métadonnées JSON
  const fetch = (await import('node-fetch')).default;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    }
  });

  const html = await res.text();

  // Spotify injecte les données dans une balise <script type="application/ld+json">
  const ldJsonMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!ldJsonMatch) throw new Error('Impossible de trouver les données Spotify dans la page.');

  const data = JSON.parse(ldJsonMatch[1]);
  const tracks = [];

  // Playlist ou album : data.track est un tableau
  if (data.track && Array.isArray(data.track)) {
    for (const t of data.track) {
      const artist = t.byArtist?.name || '';
      const name = t.name || '';
      if (name) tracks.push(`${artist} ${name}`.trim());
    }
  }
  // Track seule
  else if (data.name && data.byArtist) {
    const artist = data.byArtist?.name || '';
    tracks.push(`${artist} ${data.name}`.trim());
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

  // ── !play ────────────────────────────────────
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

    const loadingMsg = await message.reply('🔍 Récupération des pistes...');

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

    await loadingMsg.edit(`⏳ Recherche YouTube pour **${queries.length}** piste(s)...`);

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
