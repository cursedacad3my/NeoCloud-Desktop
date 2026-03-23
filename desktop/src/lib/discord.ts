import { invoke } from '@tauri-apps/api/core';
import { usePlayerStore } from '../stores/player';
import { getCurrentTime } from './audio';

let connected = false;

async function ensureConnected(): Promise<boolean> {
  if (connected) return true;
  try {
    connected = await invoke<boolean>('discord_connect');
    return connected;
  } catch {
    return false;
  }
}

function artworkToLarge(url: string | null): string | undefined {
  if (!url) return undefined;
  return url.replace(/-[^-./]+(\.[^.]+)$/, '-t500x500$1');
}

export let currentLyricLine: string | null = null;
let lastUpdateTs = 0;
let updateTimeout: number | null = null;

async function actuallyUpdateActivity() {
  const track = usePlayerStore.getState().currentTrack;
  const isPlaying = usePlayerStore.getState().isPlaying;
  
  if (!track || !isPlaying) {
    clearPresence();
    return;
  }

  if (!(await ensureConnected())) return;

  try {
    await invoke('discord_set_activity', {
      track: {
        title: track.title,
        artist: track.user.username,
        artwork_url: artworkToLarge(track.artwork_url),
        track_url: track.user.permalink_url
          ? `${track.user.permalink_url}`.replace(/\?.*$/, '')
          : undefined,
        duration_secs: Math.round(track.duration / 1000),
        elapsed_secs: Math.round(getCurrentTime()),
        lyric_line: currentLyricLine || undefined,
      },
    });
  } catch (e) {
    console.warn('[Discord] Failed to set activity:', e);
    connected = false;
  }
}

function requestDiscordUpdate() {
  const now = Date.now();
  const diff = now - lastUpdateTs;
  
  if (updateTimeout) {
    window.clearTimeout(updateTimeout);
    updateTimeout = null;
  }

  if (diff >= 1500) {
    lastUpdateTs = now;
    actuallyUpdateActivity();
  } else {
    updateTimeout = window.setTimeout(() => {
      lastUpdateTs = Date.now();
      actuallyUpdateActivity();
    }, 1500 - diff);
  }
}

export function updateDiscordLyric(lyric: string | null) {
  if (currentLyricLine === lyric) return;
  currentLyricLine = lyric;
  requestDiscordUpdate();
}

async function clearPresence() {
  if (!connected) return;
  try {
    await invoke('discord_clear_activity');
  } catch {
    connected = false;
  }
}

let lastUrn: string | null = null;
let lastPlaying = false;

usePlayerStore.subscribe((state) => {
  const { currentTrack, isPlaying } = state;

  const trackChanged = currentTrack?.urn !== lastUrn;
  const playChanged = isPlaying !== lastPlaying;

  if (trackChanged) {
    currentLyricLine = null;
  }

  if (!currentTrack || !isPlaying) {
    if (lastPlaying || trackChanged) {
      if (updateTimeout) {
        window.clearTimeout(updateTimeout);
        updateTimeout = null;
      }
      clearPresence();
    }
    lastUrn = currentTrack?.urn ?? null;
    lastPlaying = false;
    return;
  }

  if (trackChanged || playChanged) {
    lastUrn = currentTrack.urn;
    lastPlaying = isPlaying;
    
    // Always dispatch immediately for play/pause toggles or fresh tracks 
    // to keep Discord feeling responsive, but still pass through our throttle
    requestDiscordUpdate();
  }
});
