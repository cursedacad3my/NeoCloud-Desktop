import { create } from 'zustand';
import { api } from '../lib/api';
import { fetchAllLikedTracks } from '../lib/hooks';
import { usePlayerStore, type Track } from './player';
import { useDislikesStore } from './dislikes';

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

interface SoundWaveState {
  isActive: boolean;
  isInitialLoading: boolean;
  currentPreset: SoundWavePreset | null;
  seedTracks: Track[];
  genreWeights: Record<string, number>;
  artistWeights: Record<string, number>;
  playedUrns: Set<string>;
  
  init: () => Promise<void>;
  start: (preset: SoundWavePreset) => Promise<void>;
  stop: () => void;
  generateBatch: () => Promise<Track[]>;
}

export const useSoundWaveStore = create<SoundWaveState>((set, get) => ({
  isActive: false,
  isInitialLoading: false,
  currentPreset: null,
  seedTracks: [],
  genreWeights: {},
  artistWeights: {},
  playedUrns: new Set(),

  init: async () => {
    if (get().seedTracks.length > 0) return;
    set({ isInitialLoading: true });
    try {
      const tracks = await fetchAllLikedTracks(200);
      const genreCounts: Record<string, number> = {};
      const artistCounts: Record<string, number> = {};
      
      tracks.forEach((t, idx) => {
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

      set({ seedTracks: tracks, genreWeights, artistWeights, isInitialLoading: false });
    } catch (e) {
      console.error('[SoundWave] Init failed', e);
      set({ isInitialLoading: false });
    }
  },

  start: async (preset) => {
    const { init, generateBatch, stop } = get();
    stop(); // Clear previous session
    await init();
    
    set({ isActive: true, currentPreset: preset, playedUrns: new Set() });
    
    try {
      const batch = await generateBatch();
      if (batch.length > 0) {
        usePlayerStore.getState().play(batch[0], batch);
      }
    } catch (e) {
      console.error('[SoundWave] Start failed', e);
      set({ isActive: false });
    }
  },

  stop: () => {
    set({ isActive: false, currentPreset: null, playedUrns: new Set() });
  },

  generateBatch: async () => {
    const { seedTracks, genreWeights, artistWeights, currentPreset, playedUrns } = get();
    if (seedTracks.length === 0) return [];

    // Pick 5 random seeds from user's likes
    const seeds = [...seedTracks].sort(() => Math.random() - 0.5).slice(0, 5);
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
    const dislikedUrns = useDislikesStore.getState().dislikedTrackUrns;

    for (const track of flat) {
      if (!track.urn || seenUrns.has(track.urn) || playedUrns.has(track.urn) || dislikedUrns.includes(track.urn)) continue;
      seenUrns.add(track.urn);

      let score = 0;
      const genre = track.genre?.toLowerCase().trim();
      const artist = track.user?.username?.toLowerCase().trim();

      // Affinity scores
      if (genre && genreWeights[genre]) score += genreWeights[genre] * 5;
      if (artist && artistWeights[artist]) score += artistWeights[artist] * 3;

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
    finalBatch.forEach(t => playedUrns.add(t.urn));
    
    return finalBatch;
  }
}));
