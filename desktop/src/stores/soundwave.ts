import { create } from 'zustand';
import { api } from '../lib/api';
import { fetchAllLikedTracks, type FeedItem, type Playlist } from '../lib/hooks';
import { usePlayerStore, type Track } from './player';
import { useDislikesStore } from './dislikes';
import { useSettingsStore } from './settings';
import { useAuthStore } from './auth';
import { QdrantClient } from '../lib/qdrant';
import { audioAnalyser, type AudioFeatures } from '../lib/audio-analyser';

export interface SoundWavePreset {
  // ...
  name: string;
  icon: string;
  tags?: string[];
  mode?: 'favorite' | 'discover' | 'popular';
  palette?: string;
  timeHours?: number[];
}

export const ACTIVITY_PRESETS: Record<string, SoundWavePreset> = {
  wakeup: { name: 'Просыпаюсь', icon: 'sun', tags: ['chill', 'morning', 'acoustic', 'lo-fi'], timeHours: [5, 6, 7, 8, 9] },
  commute: { name: 'В дороге', icon: 'car', tags: ['electronic', 'pop', 'indie', 'drive'], timeHours: [7, 8, 9, 17, 18, 19] },
  work: { name: 'Работаю', icon: 'laptop', tags: ['focus', 'ambient', 'lo-fi', 'instrumental'], timeHours: [9, 10, 11, 12, 13, 14, 15, 16, 17] },
  workout: { name: 'Тренируюсь', icon: 'dumbbell', tags: ['workout', 'edm', 'trap', 'bass', 'energy', 'hype'], timeHours: [6, 7, 8, 17, 18, 19, 20] },
  sleep: { name: 'Засыпаю', icon: 'moon', tags: ['ambient', 'sleep', 'calm', 'piano', 'relax'], timeHours: [21, 22, 23, 0, 1, 2, 3] },
};

export const MOOD_PRESETS: Record<string, SoundWavePreset> = {
  energetic: { name: 'Бодрое', icon: 'zap', tags: ['energetic', 'upbeat', 'hype', 'edm', 'bass'], palette: 'energetic' },
  happy: { name: 'Весёлое', icon: 'music', tags: ['happy', 'fun', 'party', 'dance', 'pop'], palette: 'happy' },
  calm: { name: 'Спокойное', icon: 'waves', tags: ['calm', 'chill', 'peaceful', 'mellow', 'ambient'], palette: 'calm' },
  sad: { name: 'Грустное', icon: 'frown', tags: ['sad', 'emotional', 'melancholy', 'dark', 'indie'], palette: 'sad' },
};

export const CHARACTER_PRESETS: Record<string, SoundWavePreset> = {
  favorite: { name: 'Любимое', icon: 'heart', mode: 'favorite' },
  discover: { name: 'Незнакомое', icon: 'sparkles', mode: 'discover' },
  popular: { name: 'Популярное', icon: 'zap', mode: 'popular' },
};

export type MoodLabel = 'energetic' | 'happy' | 'calm' | 'sad';

const MOOD_TRAINING_PROFILES: Record<MoodLabel, Partial<AudioFeatures>> = {
  energetic: { valence: 0.75, arousal: 0.92, rmsEnergy: 0.85, flux: 0.65 },
  happy: { valence: 0.9, arousal: 0.64, rmsEnergy: 0.68, flux: 0.42 },
  calm: { valence: 0.46, arousal: 0.22, rmsEnergy: 0.25, flux: 0.16 },
  sad: { valence: 0.18, arousal: 0.2, rmsEnergy: 0.3, flux: 0.21 },
};

const withMoodProfile = (features: AudioFeatures | null, mood: MoodLabel): AudioFeatures => {
  const base: AudioFeatures = features || {
    rmsEnergy: 0.35,
    centroid: 0.35,
    flatness: 0.3,
    rolloff: 0.32,
    flux: 0.24,
    valence: 0.5,
    arousal: 0.5,
    bpm: 0,
  };

  return {
    ...base,
    ...MOOD_TRAINING_PROFILES[mood],
  };
};

const sanitizeCollectionPart = (value: string) => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return normalized || 'user';
};

const buildScopedCollection = (baseCollection: string, userScope: string) => {
  const base = sanitizeCollectionPart(baseCollection || 'sw_v1');
  const scope = sanitizeCollectionPart(userScope || 'local');
  return `${base}_${scope}`.slice(0, 120);
};

const extractPlaylistTracks = (input: { collection: Playlist[] } | Playlist[] | null | undefined) => {
  if (!input) return [] as Track[];
  const collection = Array.isArray(input) ? input : input.collection || [];
  const tracks: Track[] = [];
  for (const playlist of collection) {
    if (!playlist?.tracks?.length) continue;
    for (const track of playlist.tracks) {
      if (track?.urn && track.user) tracks.push(track);
    }
  }
  return tracks;
};

interface SoundWaveState {
  isActive: boolean;
  isInitialLoading: boolean;
  currentPreset: SoundWavePreset | null;
  seedTracks: Track[];
  explorePool: Track[];
  genreWeights: Record<string, number>;
  artistWeights: Record<string, number>;
  playedUrns: Set<string>;
  sessionPositive: (number | number[])[];
  sessionNegative: (number | number[])[];
  qdrant: QdrantClient | null;
  
  init: () => Promise<void>;
  start: (preset: SoundWavePreset) => Promise<void>;
  stop: () => void;
  generateBatch: () => Promise<Track[]>;
  recordFeedback: (track: Track, type: 'positive' | 'negative') => void;
  trainTrackMood: (track: Track, mood: MoodLabel) => void;
}

export const useSoundWaveStore = create<SoundWaveState>((set, get) => ({
  isActive: false,
  isInitialLoading: false,
  currentPreset: null,
  seedTracks: [],
  explorePool: [],
  genreWeights: {},
  artistWeights: {},
  playedUrns: new Set(),
  sessionPositive: [],
  sessionNegative: [],
  qdrant: null,

  init: async () => {
    if (get().seedTracks.length > 0) return;
    console.log('[SoundWave] Initialization started');
    set({ isInitialLoading: true });
    try {
      const settings = useSettingsStore.getState();
      const auth = useAuthStore.getState();
      const userScope = auth.user?.urn || (auth.user?.id ? `id_${auth.user.id}` : auth.sessionId || 'local');
      const scopedCollection = buildScopedCollection(settings.qdrantCollection || 'sw_v1', userScope);

      if (settings.qdrantEnabled && settings.qdrantUrl) {
        console.log('[SoundWave] Qdrant enabled, connecting to:', settings.qdrantUrl, 'collection:', scopedCollection);
        const client = new QdrantClient({
          url: settings.qdrantUrl,
          apiKey: settings.qdrantKey || undefined,
          collection: scopedCollection,
        });
        try {
          await client.initCollection();
          console.log('[SoundWave] Qdrant collection initialized');
          set({ qdrant: client });
        } catch (qe) {
          console.error('[SoundWave] Qdrant init failed, continuing without vector search', qe);
        }
      }

      console.log('[SoundWave] Fetching seed tracks (likes)...');
      let tracks: Track[] = [];
      try {
        tracks = await fetchAllLikedTracks(200);
        console.log(`[SoundWave] Found ${tracks.length} liked tracks`);
      } catch (likesError) {
        console.warn('[SoundWave] Failed to fetch likes, continuing with fallback sources', likesError);
      }

      console.log('[SoundWave] Fetching exploration tracks (feed/following/playlists/popular)...');
      const [feedRes, followingRes, myPlaylistsRes, likedPlaylistsRes, popularRes] = await Promise.all([
        api<{ collection: FeedItem[] }>('/me/feed?limit=60').catch(() => ({ collection: [] })),
        api<{ collection: Track[] }>('/me/followings/tracks?limit=80').catch(() => ({ collection: [] })),
        api<{ collection: Playlist[] } | Playlist[]>('/me/playlists?limit=80').catch(() => []),
        api<{ collection: Playlist[] } | Playlist[]>('/me/likes/playlists?limit=60').catch(() => []),
        api<{ collection: Track[] }>('/tracks?limit=80&linked_partitioning=true').catch(() => ({ collection: [] })),
      ]);

      const feedTracks = (feedRes.collection || [])
        .map((item) => item.origin)
        .filter((origin) => origin && origin.urn && origin.user) as Track[];

      const playlistTracks = [
        ...extractPlaylistTracks(myPlaylistsRes),
        ...extractPlaylistTracks(likedPlaylistsRes),
      ];
      console.log(`[SoundWave] Playlist-derived tracks: ${playlistTracks.length}`);

      const likedUrns = new Set(tracks.map((t) => t.urn));
      const exploreMap = new Map<string, Track>();
      [...feedTracks, ...(followingRes.collection || []), ...playlistTracks, ...(popularRes.collection || [])].forEach((track) => {
        if (!track?.urn || !track.user) return;
        if (likedUrns.has(track.urn)) return;
        if (!exploreMap.has(track.urn)) {
          exploreMap.set(track.urn, track);
        }
      });

      const explorePool = [...exploreMap.values()].slice(0, 220);
      console.log(`[SoundWave] Exploration pool size: ${explorePool.length}`);
      
      if (tracks.length === 0) {
        console.warn('[SoundWave] No liked tracks found, relying on playlists/feed/following for preferences.');
      }

      const preferenceMap = new Map<string, Track>();
      [...tracks, ...playlistTracks].forEach((track) => {
        if (!track?.urn || !track.user) return;
        if (!preferenceMap.has(track.urn)) preferenceMap.set(track.urn, track);
      });
      const preferenceTracks = [...preferenceMap.values()];

      const genreCounts: Record<string, number> = {};
      const artistCounts: Record<string, number> = {};
      
      preferenceTracks.forEach((t, idx) => {
        // Newer likes weight more
        const w = 0.3 + 0.7 * Math.exp(-idx / 80);
        const g = t.genre?.toLowerCase().trim();
        if (g) genreCounts[g] = (genreCounts[g] || 0) + w;
        
        const artist = t.user?.username?.toLowerCase().trim();
        if (artist) artistCounts[artist] = (artistCounts[artist] || 0) + w;
      });

      const maxG = Math.max(1, ...Object.values(genreCounts));
      const genreWeights: Record<string, number> = {};
      for (const [g, c] of Object.entries(genreCounts)) genreWeights[g] = c / maxG;

      const maxA = Math.max(1, ...Object.values(artistCounts));
      const artistWeights: Record<string, number> = {};
      for (const [a, c] of Object.entries(artistCounts)) artistWeights[a] = c / maxA;

      console.log('[SoundWave] Weights calculated, genres:', Object.keys(genreWeights).length);
      set({ seedTracks: tracks, explorePool, genreWeights, artistWeights, isInitialLoading: false });

      // Seed Qdrant in background if available
      const q = get().qdrant;
      if (q && (tracks.length > 0 || explorePool.length > 0)) {
        console.log('[SoundWave] Seeding Qdrant in background...');
        q.upsert([
          ...tracks.map(t => ({ track: t, features: null, isLiked: true })),
          ...explorePool.map(t => ({ track: t, features: null, isLiked: false })),
        ]).catch(e => 
          console.error('[SoundWave] Qdrant seeding failed', e)
        );
      }
    } catch (e) {
      console.error('[SoundWave] Init failed critically', e);
      set({ isInitialLoading: false });
    }
  },

  start: async (preset: SoundWavePreset) => {
    const { init, generateBatch, stop } = get();
    console.log('[SoundWave] Starting preset:', preset.name);
    stop(); // Clear previous session
    await init();
    
    set({ 
      isActive: true, 
      currentPreset: preset, 
      playedUrns: new Set(),
      sessionPositive: [],
      sessionNegative: []
    });
    
    try {
      console.log('[SoundWave] Generating first batch...');
      const batch = await generateBatch();
      console.log(`[SoundWave] First batch generated: ${batch.length} tracks`);
      if (batch.length > 0) {
        usePlayerStore.getState().play(batch[0], batch);
      } else {
        console.error('[SoundWave] Failed to generate initial batch');
      }
    } catch (e) {
      console.error('[SoundWave] Start failed', e);
      set({ isActive: false });
    }
  },

  stop: () => {
    console.log('[SoundWave] Stopped');
    set({ isActive: false, currentPreset: null, playedUrns: new Set(), sessionPositive: [], sessionNegative: [] });
  },

  recordFeedback: (track: Track, type: 'positive' | 'negative') => {
    const { qdrant, sessionPositive, sessionNegative } = get();
    if (!qdrant) return;

    const id = qdrant.urnToId(track.urn);
    if (!id) return;

    const features = audioAnalyser.getFeatures(track.urn);
    
    console.log(`[SoundWave] Recording ${type} feedback for: ${track.title}`);

    if (type === 'positive') {
      if (!sessionPositive.includes(id)) {
        set({ sessionPositive: [...sessionPositive, id].slice(-30) });
      }
    } else {
      if (!sessionNegative.includes(id)) {
        set({ sessionNegative: [...sessionNegative, id].slice(-20) });
      }
    }

    // Index the track as a non-liked point for future recommendations
    qdrant.upsert([{ track, features, isLiked: false }]).catch(e => 
      console.error('[SoundWave] Feedback indexing failed', e)
    );
  },

  trainTrackMood: (track: Track, mood: MoodLabel) => {
    const { qdrant, sessionPositive } = get();
    if (!qdrant || !track?.urn) return;

    const id = qdrant.urnToId(track.urn);
    if (!id) return;

    const current = audioAnalyser.getFeatures(track.urn);
    const trainedFeatures = withMoodProfile(current, mood);

    console.log(`[SoundWave] Mood training: ${track.title} -> ${mood}`);

    if (!sessionPositive.includes(id)) {
      set({ sessionPositive: [...sessionPositive, id].slice(-30) });
    }

    qdrant
      .upsert([{ track, features: trainedFeatures, isLiked: false }])
      .catch((e) => console.error('[SoundWave] Mood training indexing failed', e));
  },

  generateBatch: async () => {
    const { seedTracks, explorePool, genreWeights, artistWeights, currentPreset, playedUrns, qdrant, sessionPositive, sessionNegative } = get();
    if (seedTracks.length === 0 && explorePool.length === 0) {
      console.error('[SoundWave] Cannot generate batch: no seed tracks available');
      return [];
    }

    const dislikedUrns = useDislikesStore.getState().dislikedTrackUrns;
    const likedUrns = new Set(seedTracks.map((t) => t.urn));

    if (qdrant) {
      try {
        console.log('[SoundWave] Generating batch via Qdrant...');
        // Use Qdrant Recommend API
        let positive: (number | number[])[] = [...sessionPositive];
        if (positive.length === 0) {
          // Cold start: discover uses explore pool first, others use liked tracks
          const discoverSelection = currentPreset?.mode === 'discover'
            ? [...explorePool].sort(() => Math.random() - 0.5).slice(0, 8)
            : [];
          const likedSelection = [...seedTracks].sort(() => Math.random() - 0.5).slice(0, 10);
          const upsertBatch = [
            ...discoverSelection.map((t) => ({ track: t, features: null, isLiked: false })),
            ...likedSelection.map((t) => ({ track: t, features: null, isLiked: true })),
          ];

          if (upsertBatch.length > 0) {
            await qdrant.upsert(upsertBatch);
          }

          positive = [...discoverSelection, ...likedSelection]
            .map((t: Track) => qdrant.urnToId(t.urn))
            .filter((id) => id > 0);
          console.log('[SoundWave] Using cold-start seeds:', positive.length);
        }

        if (positive.length === 0) {
          throw new Error('No valid positive seeds for Qdrant recommend');
        }

        const discoverNegatives =
          currentPreset?.mode === 'discover' && sessionNegative.length === 0
            ? [...seedTracks]
                .sort(() => Math.random() - 0.5)
                .slice(0, 8)
                .map((t) => qdrant.urnToId(t.urn))
                .filter((id) => id > 0)
            : [];

        const results = await qdrant.recommend({
          positive,
          negative: [...sessionNegative, ...discoverNegatives],
          limit: 30
        });
        console.log(`[SoundWave] Qdrant returned ${results.length} recommendations`);

        const tracks = results.map((r: any) => {
          const payload = r?.payload || {};
          const urn = payload.urn || (r?.id ? `soundcloud:tracks:${r.id}` : '');
          const fallbackId = typeof r?.id === 'number' ? r.id : qdrant.urnToId(urn);
          const artist = payload.artist || 'Unknown Artist';

          return {
            id: payload.id || fallbackId || 0,
            urn,
            title: payload.title || 'Unknown Track',
            duration: payload.duration || 210000,
            artwork_url: payload.artwork_url || null,
            genre: payload.genre || '',
            tag_list: payload.tag_list || '',
            playback_count: payload.playback_count || 0,
            likes_count: payload.likes_count || payload.favoritings_count || 0,
            favoritings_count: payload.favoritings_count || payload.likes_count || 0,
            user: {
              id: 0,
              urn: payload.user_urn || 'soundcloud:users:0',
              username: artist,
              avatar_url: payload.user_avatar_url || '',
              permalink_url: payload.user_permalink_url || '',
            },
            isLiked: Boolean(payload.isLiked),
            _qdrant: true,
          } as unknown as Track;
        });

        const filtered = tracks.filter((t: Track) => {
          if (!t.urn) return false;
          if (playedUrns.has(t.urn)) return false;
          if (dislikedUrns.includes(t.urn)) return false;

          const isLiked = likedUrns.has(t.urn) || Boolean((t as Track & { isLiked?: boolean }).isLiked);
          if (currentPreset?.mode === 'discover' && isLiked) return false;

          return true;
        });
        console.log(`[SoundWave] Filtered batch: ${filtered.length} new tracks found`);

        if (currentPreset?.mode === 'discover' && filtered.length < 12) {
          const needed = 12 - filtered.length;
          const exploreFill = [...explorePool]
            .filter((t) => t.urn && !playedUrns.has(t.urn) && !dislikedUrns.includes(t.urn) && !likedUrns.has(t.urn))
            .sort(() => Math.random() - 0.5)
            .slice(0, needed);

          if (exploreFill.length > 0) {
            console.log(`[SoundWave] Added ${exploreFill.length} explore fallback tracks`);
            filtered.push(...exploreFill);
          }
        }

        if (filtered.length > 0) {
          filtered.forEach((t: Track) => {
            playedUrns.add(t.urn);
          });
          return filtered.slice(0, 20);
        }

        console.warn('[SoundWave] Qdrant produced no usable tracks, falling back to legacy algorithm');
      } catch (e) {
        console.error('[SoundWave] Qdrant recommend failed, falling back to legacy algorithm', e);
      }
    }

    console.log('[SoundWave] Generating batch via Legacy Algorithm...');

    // Fallback to legacy algorithm...

    // Pick 5 random seeds from user's likes
    const seedBase = currentPreset?.mode === 'discover' && explorePool.length > 0 ? explorePool : seedTracks;
    if (seedBase.length === 0) {
      return [];
    }
    const seeds = [...seedBase].sort(() => Math.random() - 0.5).slice(0, 5);
    const candidates: { track: Track; score: number }[] = [];
    const seenUrns = new Set<string>();

    // Step 1: Fetch related tracks for each seed
    const results = await Promise.all(
      seeds.map((s) => 
        api<{ collection: Track[] }>(`/tracks/${encodeURIComponent(s.urn)}/related?limit=20`)
          .then(res => res.collection || [])
          .catch(() => [])
      )
    );

    // Step 2: Scoring
    const flat = results.flat();

    for (const track of flat) {
      if (!track.urn || seenUrns.has(track.urn) || playedUrns.has(track.urn) || dislikedUrns.includes(track.urn)) continue;
      seenUrns.add(track.urn);

      let score = 0;
      const genre = track.genre?.toLowerCase().trim();
      const artist = track.user?.username?.toLowerCase().trim();
      const isLiked = likedUrns.has(track.urn) || Boolean(track.user_favorite);

      if (currentPreset?.mode === 'discover' && isLiked) {
        continue;
      }

      // Affinity scores
      if (currentPreset?.mode === 'discover') {
        const gw = genre && genreWeights[genre] ? genreWeights[genre] : 0;
        const aw = artist && artistWeights[artist] ? artistWeights[artist] : 0;
        score += (1 - gw) * 4;
        score += aw > 0 ? -aw * 6 : 1.5;
      } else {
        if (genre && genreWeights[genre]) score += genreWeights[genre] * 5;
        if (artist && artistWeights[artist]) score += artistWeights[artist] * 3;
        if (currentPreset?.mode !== 'favorite' && isLiked) score -= 8;
      }

      // Preset matching
      if (currentPreset?.tags) {
        const trackText = `${track.genre} ${track.tag_list} ${track.title} ${track.description}`.toLowerCase();
        let matchCount = 0;
        for (const tag of currentPreset.tags) {
          if (trackText.includes(tag.toLowerCase())) matchCount++;
        }
        score += matchCount * 4;
      }

      // Mode adjustments
      const plays = track.playback_count || 0;
      if (currentPreset?.mode === 'popular') {
        score += Math.min(10, plays / 100000);
      } else if (currentPreset?.mode === 'discover') {
        if (plays < 5000) score += 10;
        else if (plays < 50000) score += 5;
        else score -= 5;
      }

      // Penalty for "Type Beats"
      if (/\b(free|type\s*beat|instrumental|prod|минус|бит)\b/i.test(track.title || '')) {
        score -= 15;
      }

      candidates.push({ track, score });
    }

    // Sort by score and take top 20
    const finalBatch = candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(c => c.track);

    // Track played URNs to avoid repeats
    finalBatch.forEach(t => {
      playedUrns.add(t.urn);
    });
    
    return finalBatch;
  }
}));
