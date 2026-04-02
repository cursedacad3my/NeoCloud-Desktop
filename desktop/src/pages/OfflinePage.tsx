import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { listCachedLyricsUrns, listCachedUrns, removeLyricsForTrack } from '../lib/cache';
import { art, dur } from '../lib/formatters';
import { fetchAllLikedTracks, invalidateAllLikesCache } from '../lib/hooks';
import {
  AlertCircle,
  Download,
  Globe,
  Heart,
  Music,
  Play,
  RotateCcw,
  Settings,
} from '../lib/icons';
import {
  getOfflineIndexUpdatedAt,
  getOfflineLikedTracks,
  getOfflineTracksByUrns,
} from '../lib/offline-index';
import { type AppMode, useAppStatusStore } from '../stores/app-status';
import type { Track } from '../stores/player';
import { usePlayerStore } from '../stores/player';

interface OfflineLibraryState {
  likedTracks: Track[];
  cachedTracks: Track[];
  cachedUrns: Set<string>;
  cachedLyricsUrns: Set<string>;
  updatedAt: number | null;
}

type OfflineSectionKey = 'likes' | 'cached';

const EMPTY_STATE: OfflineLibraryState = {
  likedTracks: [],
  cachedTracks: [],
  cachedUrns: new Set(),
  cachedLyricsUrns: new Set(),
  updatedAt: null,
};

function resolveMode(state: {
  soundcloudBlocked: boolean;
  navigatorOnline: boolean;
  backendReachable: boolean;
}): AppMode {
  if (state.soundcloudBlocked) return 'blocked';
  if (!state.navigatorOnline || !state.backendReachable) return 'offline';
  return 'online';
}

const OfflineTrackRow = React.memo(function OfflineTrackRow({
  track,
  queue,
  canPlay,
  cached,
  lyricsCached,
  onClearLyrics,
}: {
  track: Track;
  queue: Track[];
  canPlay: boolean;
  cached: boolean;
  lyricsCached: boolean;
  onClearLyrics: (urn: string) => void;
}) {
  const { t } = useTranslation();
  const play = usePlayerStore((s) => s.play);
  const artwork = art(track.artwork_url, 't200x200');

  return (
  

    <div
      className={`group flex items-center gap-4 rounded-[24px] border px-4 py-3 transition-all duration-300 ease-[var(--ease-apple)] ${
        canPlay
          ? 'border-white/8 bg-white/[0.035] hover:border-white/14 hover:bg-white/[0.06] hover:shadow-[0_4px_24px_rgba(0,0,0,0.15)]'
          : 'border-white/6 bg-white/[0.02] opacity-60'
      }`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '82px' }}
    >
      <button
        type="button"
        onClick={() => canPlay && play(track, queue)}
        disabled={!canPlay}
        className={`relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-[18px] border transition-all ${
          canPlay
            ? 'cursor-pointer border-white/12 bg-white/[0.08] text-white/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:scale-[1.03]'
            : 'cursor-not-allowed border-white/8 bg-white/[0.04] text-white/25'
        }`}
      >
        {artwork ? (
          <>
            <img
              src={artwork}
              alt=""
              className="size-full object-cover"
              decoding="async"
              loading="lazy"
            />
            {canPlay && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all group-hover:bg-black/40 group-hover:opacity-100">
                <Play size={16} fill="white" strokeWidth={0} />
              </div>
            )}
          </>
        ) : (
          <Music size={18} />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold text-white/92">{track.title}</div>
        <div className="mt-1 truncate text-[12px] text-white/42">{track.user.username}</div>
      </div>

      <div className="hidden shrink-0 items-center gap-2 sm:flex">
        {lyricsCached && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClearLyrics(track.urn);
            }}
            title={t('offline.clearLyrics', 'Clear cached lyrics')}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-sky-400/18 bg-sky-400/10 px-2.5 py-1 text-[11px] font-medium text-sky-100/90 transition-colors hover:bg-sky-400/20"
          >
            {t('offline.lyrics', 'Lyrics')}
            <span className="text-[10px] opacity-70">x</span>
          </button>
        )}

        {cached ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/16 bg-emerald-400/8 px-2.5 py-1 text-[11px] font-medium text-emerald-100/80">
            <Download size={12} />
            {t('offline.cached')}
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-white/30">
            {t('offline.notCached')}
          </span>
        )}
      </div>

      <div className="w-14 shrink-0 text-right text-[12px] font-medium tabular-nums text-white/30">
        {dur(track.duration)}
      </div>
    </div>
  );
});

const OverviewMetric = React.memo(function OverviewMetric({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: 'likes' | 'playable' | 'cached';
}) {
  const styles = {
    likes: {
      border: 'border-accent/16',
      bg: 'bg-accent/[0.08]',
      icon: 'border-accent/18 bg-accent/[0.14] text-white/88',
    },
    playable: {
      border: 'border-emerald-400/16',
      bg: 'bg-emerald-400/[0.08]',
      icon: 'border-emerald-400/16 bg-emerald-400/[0.12] text-emerald-50',
    },
    cached: {




      border: 'border-sky-400/16',
      bg: 'bg-sky-400/[0.08]',
      icon: 'border-sky-400/16 bg-sky-400/[0.12] text-sky-50',
    },
  }[tone];

  return (
    <div
      className={`rounded-[26px] border ${styles.border} ${styles.bg} px-4 py-4 backdrop-blur-sm`}
    >
      <div
        className={`flex size-11 items-center justify-center rounded-[18px] border ${styles.icon}`}
      >
        {icon}
      </div>
      <div className="mt-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/35">
        {label}
      </div>
      <div className="mt-1 text-[30px] font-semibold tracking-[-0.05em] text-white/94">{value}</div>
    </div>
  );
});

const SectionSwitchCard = React.memo(function SectionSwitchCard({
  active,
  count,
  details,
  icon,
  onClick,
  title,
  tone,
}: {
  active: boolean;
  count: number;
  details: Array<{ label: string; value: number }>;
  icon: React.ReactNode;
  onClick: () => void;
  title: string;
  tone: OfflineSectionKey;
}) {
  const styles = {
    likes: {
      activeBorder: 'border-accent/18',
      activeBg: 'bg-accent/[0.09]',
      activeIcon: 'border-accent/18 bg-accent/[0.14] text-white/88',
      activeCount: 'border-accent/18 bg-accent/[0.14] text-white/88',
      glow: 'shadow-[0_18px_50px_rgba(255,85,0,0.08)]',
    },
    cached: {
      activeBorder: 'border-sky-400/18',
      activeBg: 'bg-sky-400/[0.08]',
      activeIcon: 'border-sky-400/16 bg-sky-400/[0.14] text-sky-50',
      activeCount: 'border-sky-400/16 bg-sky-400/[0.14] text-sky-50',
      glow: 'shadow-[0_18px_50px_rgba(56,189,248,0.08)]',
    },
  }[tone];

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group w-full cursor-pointer rounded-[30px] border p-5 text-left transition-all duration-300 ease-[var(--ease-apple)] ${
        active
          ? `${styles.activeBorder} ${styles.activeBg} ${styles.glow}`
          : 'border-white/8 bg-white/[0.03] hover:border-white/12 hover:bg-white/[0.05]'
      }`}
    >
      <div className="flex items-start gap-4">
        <div
          className={`flex size-12 shrink-0 items-center justify-center rounded-[18px] border ${
            active
              ? styles.activeIcon
              : 'border-white/10 bg-white/[0.05] text-white/72 group-hover:text-white/86'
          }`}
        >
          {icon}
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-semibold tracking-tight text-white/92">{title}</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {details.map((detail) => (
              <div
                key={detail.label}
                className="inline-flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1.5"
              >
                <span className="text-[11px] font-medium text-white/36">{detail.label}</span>
                <span className="text-[11px] font-semibold tabular-nums text-white/88">
                  {detail.value}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div
          className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${
            active
              ? styles.activeCount
              : 'border-white/8 bg-white/[0.05] text-white/36 group-hover:text-white/52'
          }`}
        >
          {count}
        </div>
      </div>
    </button>
  );
});

function OfflineSection({
  icon,
  title,
  items,
  queue,
  cachedUrns,
  cachedLyricsUrns,
  canPlayTrack,
  onClearLyrics,
  emptyText,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  items: Track[];
  queue: Track[];
  cachedUrns: Set<string>;
  cachedLyricsUrns: Set<string>;
  canPlayTrack: (track: Track) => boolean;
  onClearLyrics: (urn: string) => void;
  emptyText: string;
  tone: OfflineSectionKey;
}) {
  const styles = {
    likes: {
      border: 'border-accent/14',
      icon: 'border-accent/18 bg-accent/[0.14] text-white/88',
      badge: 'border-accent/18 bg-accent/[0.14] text-white/88',
      glow: 'bg-[radial-gradient(circle_at_top_left,rgba(255,85,0,0.18),transparent_58%)]',
    },
    cached: {
      border: 'border-sky-400/14',
      icon: 'border-sky-400/16 bg-sky-400/[0.14] text-sky-50',
      badge: 'border-sky-400/16 bg-sky-400/[0.14] text-sky-50',
      glow: 'bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.18),transparent_58%)]',
    },
  }[tone];

  return (
    <section
      className={`relative overflow-hidden rounded-[34px] border ${styles.border} bg-black/24 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.28)] backdrop-blur-[32px] md:p-6`}
    >
      <div className={`pointer-events-none absolute inset-0 ${styles.glow}`} />

      <div className="relative flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={`flex size-12 shrink-0 items-center justify-center rounded-[18px] border ${styles.icon}`}
            >
              {icon}
            </div>
            <div className="min-w-0">
              <h2 className="text-[22px] font-semibold tracking-[-0.03em] text-white/94">
                {title}
              </h2>
            </div>
          </div>

          <div
            className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${styles.badge}`}
          >
            {items.length}
          </div>
        </div>

        {items.length > 0 ? (
          <div className="max-h-[58vh] space-y-3 overflow-y-auto border-t border-white/6 pt-4 pr-1">
            {items.map((track) => (
              <OfflineTrackRow
                key={track.urn}
                track={track}
                queue={queue}
                canPlay={canPlayTrack(track)}
                cached={cachedUrns.has(track.urn)}
                lyricsCached={cachedLyricsUrns.has(track.urn)}
                onClearLyrics={onClearLyrics}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-[24px] border border-dashed border-white/8 bg-white/[0.02] px-5 py-10 text-center text-[13px] text-white/30">
            {emptyText}
          </div>
        )}
      </div>
    </section>
  );
}

export const OfflinePage = React.memo(() => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const appMode = useAppStatusStore(resolveMode);
  const [state, setState] = useState<OfflineLibraryState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeSection, setActiveSection] = useState<OfflineSectionKey>('likes');

  const loadOfflineData = useCallback(async () => {
    const [likedTracks, cachedUrns, lyricsUrns, updatedAt] = await Promise.all([
      getOfflineLikedTracks(),
      listCachedUrns(),
      listCachedLyricsUrns(),
      getOfflineIndexUpdatedAt(),
    ]);

    const cachedSet = new Set(cachedUrns);
    const cachedLyricsSet = new Set(lyricsUrns);
    const cachedTracks = await getOfflineTracksByUrns(cachedUrns);

    setState({
      likedTracks,
      cachedTracks,
      cachedUrns: cachedSet,
      cachedLyricsUrns: cachedLyricsSet,
      updatedAt,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      try {
        await loadOfflineData();
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void hydrate();

    return () => {
      cancelled = true;
    };
  }, [loadOfflineData]);

  useEffect(() => {
    if (appMode !== 'online') return;

    let cancelled = false;

    const syncLikesInBackground = async () => {
      try {
        await fetchAllLikedTracks();
        if (!cancelled) await loadOfflineData();
      } catch {
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void syncLikesInBackground();

    return () => {
      cancelled = true;
    };
  }, [appMode, loadOfflineData]);

  useEffect(() => {
    if (activeSection === 'likes' && state.likedTracks.length === 0 && state.cachedTracks.length > 0) {
      setActiveSection('cached');
    }
    if (activeSection === 'cached' && state.cachedTracks.length === 0 && state.likedTracks.length > 0) {
      setActiveSection('likes');
    }
  }, [activeSection, state.cachedTracks.length, state.likedTracks.length]);

  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      invalidateAllLikesCache();
      await fetchAllLikedTracks();
      await loadOfflineData();
    } finally {
      setSyncing(false);
    }
  }, [loadOfflineData]);

  const handleClearLyrics = useCallback(async (urn: string) => {
    await removeLyricsForTrack(urn);
    setState((prev) => {
      const nextLyrics = new Set(prev.cachedLyricsUrns);
      nextLyrics.delete(urn);
      return { ...prev, cachedLyricsUrns: nextLyrics };
    });
  }, []);
 
   const cachedLikesCount = useMemo(
    () => state.likedTracks.filter((track) => state.cachedUrns.has(track.urn)).length,
    [state.cachedUrns, state.likedTracks],
  );

  const likedPlayableQueue = useMemo(
    () => state.likedTracks.filter((track) => state.cachedUrns.has(track.urn)),
    [state.cachedUrns, state.likedTracks],
  );

  const likesQueue = appMode === 'online' ? state.likedTracks : likedPlayableQueue;
  const cachedQueue = state.cachedTracks;

  const statusConfig = {
    blocked: {
      border: 'border-amber-400/20',
      bg: 'bg-amber-400/10',
      text: 'text-amber-200/90',
      glow: 'shadow-[0_0_20px_rgba(251,191,36,0.08)]',
      icon: <AlertCircle size={12} />,
      label: t('offline.blockedBadge'),
      title: t('offline.blockedTitle'),
      description: t('offline.blockedDescription'),
    },
    offline: {
      border: 'border-sky-400/20',
      bg: 'bg-sky-400/10',
      text: 'text-sky-100/90',
      glow: 'shadow-[0_0_20px_rgba(56,189,248,0.08)]',
      icon: <Globe size={12} />,
      label: t('offline.offlineBadge'),
      title: t('offline.offlineTitle'),
      description: t('offline.offlineDescription'),
    },
    online: {
      border: 'border-emerald-400/20',
      bg: 'bg-emerald-400/10',
      text: 'text-emerald-100/90',
      glow: 'shadow-[0_0_20px_rgba(52,211,153,0.08)]',
      icon: <Download size={12} />,
      label: t('offline.readyBadge'),
      title: t('offline.readyTitle'),
      description: t('offline.readyDescription'),
    },
  }[appMode];

  const lastSyncText = useMemo(() => {
    if (!state.updatedAt) return null;

    const locale = i18n.language === 'ru' ? 'ru-RU' : 'en-US';
    const formatted = new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(state.updatedAt);

    return t('offline.lastSync', { date: formatted });
  }, [i18n.language, state.updatedAt, t]);

  return (
    <div className="relative min-h-full overflow-hidden px-6 py-6 md:px-8 md:py-8">
      <div
        className="pointer-events-none absolute inset-0"
        style={{ contain: 'strict', transform: 'translateZ(0)' }}
      >
        <div className="absolute left-[-10%] top-[-8%] h-[480px] w-[480px] rounded-full bg-accent/[0.07] blur-[140px]" />
        <div className="absolute bottom-[-14%] right-[-10%] h-[520px] w-[520px] rounded-full bg-sky-400/[0.05] blur-[160px]" />
        {appMode === 'blocked' && (
          <div className="absolute left-[40%] top-[20%] h-[300px] w-[300px] rounded-full bg-amber-500/[0.04] blur-[120px]" />
        )}
      </div>

      <div
        className="relative mx-auto flex w-full max-w-[1180px] flex-col gap-5"
        style={{ isolation: 'isolate' }}
      >
        <section className="relative overflow-hidden rounded-[38px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03))] p-[1px] shadow-[0_24px_80px_rgba(0,0,0,0.28),0_0_1px_rgba(255,255,255,0.1)] backdrop-blur-[40px]">
          <div className="pointer-events-none absolute inset-0 rounded-[38px] bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.06),transparent_60%)]" />

          <div className="relative rounded-[37px] bg-black/25 px-5 py-5 md:px-6 md:py-6">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div className="max-w-3xl">
                <div
                  className={`inline-flex items-center gap-2 rounded-full border ${statusConfig.border} ${statusConfig.bg} ${statusConfig.glow} px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] ${statusConfig.text} backdrop-blur-sm`}
                >
                  {statusConfig.icon}
                  {statusConfig.label}
                </div>

                <h1 className="mt-4 text-[30px] font-semibold tracking-[-0.05em] text-white/94 md:text-[34px]">
                  {statusConfig.title}
                </h1>

                <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-white/45">
                  {statusConfig.description}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3 xl:justify-end">
                {lastSyncText && (
                  <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12px] font-medium text-white/45">
                    {lastSyncText}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleSyncNow}
                  disabled={syncing || appMode !== 'online'}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-[16px] border border-white/10 bg-white/[0.06] px-4 py-2.5 text-[13px] font-semibold text-white/80 shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition-all hover:border-white/14 hover:bg-white/[0.10] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RotateCcw size={15} className={syncing ? 'animate-spin' : ''} />
                  {t('offline.syncNow')}
                </button>

                <button
                  type="button"
                  onClick={() => navigate('/settings')}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-[16px] border border-white/10 bg-white/[0.06] px-4 py-2.5 text-[13px] font-semibold text-white/80 shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition-all hover:border-white/14 hover:bg-white/[0.10]"
                >
                  <Settings size={15} />
                  {t('offline.openSettings')}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    useAppStatusStore.getState().resetConnectivity();
                    navigate('/');
                  }}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-[16px] border border-white/10 bg-white/[0.06] px-4 py-2.5 text-[13px] font-semibold text-white/80 shadow-[0_2px_8px_rgba(0,0,0,0.1)] transition-all hover:border-white/14 hover:bg-white/[0.10]"
                >
                  <RotateCcw size={15} />
                  {t('offline.tryOnline')}
                </button>
              </div>
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-3">
              <OverviewMetric
                icon={<Heart size={18} />}
                label={t('offline.statsLikes')}
                value={state.likedTracks.length}
                tone="likes"
              />
              <OverviewMetric
                icon={<Download size={18} />}
                label={t('offline.likesTitle')}
                value={cachedLikesCount}
                tone="playable"
              />
              <OverviewMetric
                icon={<Download size={18} />}
                label={t('offline.statsCached')}
                value={state.cachedTracks.length}
                tone="cached"
              />
            </div>
          </div>
        </section>

        {loading ? (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              {Array.from({ length: 2 }).map((_, index) => (
                <div
                  key={index}
                  className="h-[148px] animate-pulse rounded-[30px] border border-white/6 bg-white/[0.02] backdrop-blur-[24px]"
                />
              ))}
            </div>
            <div className="h-[520px] animate-pulse rounded-[34px] border border-white/6 bg-white/[0.02] backdrop-blur-[24px]" />
          </>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <SectionSwitchCard
                active={activeSection === 'likes'}
                count={state.likedTracks.length}
                details={[
                  { label: t('offline.statsLikes'), value: state.likedTracks.length },
                  { label: t('offline.cached'), value: cachedLikesCount },
                ]}
                icon={<Heart size={18} />}
                onClick={() => setActiveSection('likes')}
                title={t('offline.likesTitle')}
                tone="likes"
              />
              <SectionSwitchCard
                active={activeSection === 'cached'}
                count={state.cachedTracks.length}
                details={[
                  { label: t('offline.statsCached'), value: state.cachedTracks.length },
                  { label: t('offline.likesTitle'), value: cachedLikesCount },
                ]}
                icon={<Download size={18} />}
                onClick={() => setActiveSection('cached')}
                title={t('offline.cachedTitle')}
                tone="cached"
              />
            </div>

            {activeSection === 'likes' ? (
              <OfflineSection
                icon={<Heart size={18} />}
                title={t('offline.likesTitle')}
                items={state.likedTracks}
                queue={likesQueue}
                cachedUrns={state.cachedUrns}
                cachedLyricsUrns={state.cachedLyricsUrns}
                canPlayTrack={(track) => appMode === 'online' || state.cachedUrns.has(track.urn)}
                onClearLyrics={handleClearLyrics}
                emptyText={t('offline.likesEmpty')}
                tone="likes"
              />
            ) : (
              <OfflineSection
                icon={<Download size={18} />}
                title={t('offline.cachedTitle')}
                items={state.cachedTracks}
                queue={cachedQueue}
                cachedUrns={state.cachedUrns}
                cachedLyricsUrns={state.cachedLyricsUrns}
                canPlayTrack={() => true}
                onClearLyrics={handleClearLyrics}
                emptyText={t('offline.cachedEmpty')}
                tone="cached"
              />
            )}
          </>
        )}
      </div>
    </div>
  );
});