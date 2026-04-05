import type { Readable } from 'node:stream';
import { HttpService } from '@nestjs/axios';
import { BadGatewayException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScPublicAnonService } from '../soundcloud/sc-public-anon.service.js';
import { ScPublicCookiesService } from '../soundcloud/sc-public-cookies.service.js';
import { streamFromHls } from '../soundcloud/sc-public-utils.js';
import { SoundcloudService } from '../soundcloud/soundcloud.service.js';
import type {
  ScComment,
  ScPaginatedResponse,
  ScStreams,
  ScTrack,
  ScUser,
} from '../soundcloud/soundcloud.types.js';

@Injectable()
export class TracksService {
  private readonly logger = new Logger(TracksService.name);
  private hqOauthDisabledUntil = 0;
  private readonly qwenAsrUrl: string;
  private readonly qwenAsrKey: string;

  constructor(
    private readonly sc: SoundcloudService,
    private readonly scPublicAnon: ScPublicAnonService,
    private readonly scPublicCookies: ScPublicCookiesService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.qwenAsrUrl = this.configService.get<string>('lyrics.qwenAsrUrl')?.trim() ?? '';
    this.qwenAsrKey = this.configService.get<string>('lyrics.qwenAsrKey')?.trim() ?? '';
  }

  search(token: string, params?: Record<string, unknown>): Promise<ScPaginatedResponse<ScTrack>> {
    return this.sc.apiGet('/tracks', token, params);
  }

  getById(token: string, trackUrn: string, params?: Record<string, unknown>): Promise<ScTrack> {
    return this.sc.apiGet(`/tracks/${trackUrn}`, token, params);
  }

  update(token: string, trackUrn: string, body: unknown): Promise<ScTrack> {
    return this.sc.apiPut(`/tracks/${trackUrn}`, token, body);
  }

  delete(token: string, trackUrn: string): Promise<unknown> {
    return this.sc.apiDelete(`/tracks/${trackUrn}`, token);
  }

  getStreams(
    token: string,
    trackUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScStreams> {
    return this.sc.apiGet(`/tracks/${trackUrn}/streams`, token, params);
  }

  proxyStream(
    token: string,
    url: string,
    range?: string,
  ): Promise<{ stream: Readable; headers: Record<string, string> }> {
    return this.sc.proxyStream(url, token, range);
  }

  async syncLyricsWithQwen(
    token: string,
    trackUrn: string,
    plainLyrics: string,
    artist?: string,
    title?: string,
    format = 'http_mp3_128',
  ): Promise<unknown> {
    if (!this.qwenAsrUrl) {
      throw new ServiceUnavailableException('Qwen aligner is not configured');
    }

    const streamData = await this.getStreamWithFallback(token, trackUrn, format, {}, undefined, true);
    if (!streamData) {
      throw new NotFoundException('Track not available for ASR sync');
    }

    const audioBuffer = await this.readStreamToBuffer(streamData.stream);
    const audioArrayBuffer = audioBuffer.buffer.slice(
      audioBuffer.byteOffset,
      audioBuffer.byteOffset + audioBuffer.byteLength,
    ) as ArrayBuffer;
    const contentType = streamData.headers['content-type'] || 'audio/mpeg';
    const form = new FormData();
    const fileName = `${trackUrn.replace(/[^a-z0-9_-]+/gi, '_')}.${this.extensionFromMime(contentType)}`;

    form.append('audio', new Blob([audioArrayBuffer], { type: contentType }), fileName);
    form.append('lyrics', plainLyrics);
    form.append('plainLyrics', plainLyrics);
    form.append('trackUrn', trackUrn);
    if (artist) form.append('artist', artist);
    if (title) form.append('title', title);

    const headers: Record<string, string> = {};
    if (this.qwenAsrKey) {
      headers.authorization = `Bearer ${this.qwenAsrKey}`;
      headers['x-api-key'] = this.qwenAsrKey;
    }

    form.append('language', 'Russian');
    form.append('mode', 'forced_alignment');
    form.append('format', 'words');

    const response = await fetch(this.qwenAsrUrl, {
      method: 'POST',
      headers,
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new BadGatewayException(`Qwen aligner failed: ${response.status}${body ? ` ${body}` : ''}`);
    }

    const responseType = response.headers.get('content-type') || '';
    if (responseType.includes('application/json')) {
      return await response.json();
    }

    return await response.text();
  }

  async getStreamWithFallback(
    token: string,
    trackUrn: string,
    format: string,
    params: Record<string, unknown>,
    range?: string,
    hq = false,
  ): Promise<{ stream: Readable; headers: Record<string, string> } | null> {
    let access: 'playable' | 'preview' | 'blocked' = 'playable';

    try {
      const track = await this.sc.apiGet<ScTrack>(`/tracks/${trackUrn}`, token, params);
      access = track.access;
    } catch {
      // no-op, fallback chain below
    }

    if (hq || access !== 'playable') {
      const cookie = await this.getCookieStream(trackUrn);
      if (cookie) return cookie;

      const oauth = await this.tryOAuthStream(token, trackUrn, format, params, range);
      if (oauth) return oauth;

      return this.getPublicStream(trackUrn, format);
    }

    const oauth = await this.tryOAuthStream(token, trackUrn, format, params, range);
    if (oauth) return oauth;

    const pub = await this.getPublicStream(trackUrn, format);
    if (pub) return pub;

    return this.getCookieStream(trackUrn);
  }

  async tryOAuthStream(
    token: string,
    trackUrn: string,
    format: string,
    params: Record<string, unknown>,
    range?: string,
  ): Promise<{ stream: Readable; headers: Record<string, string> } | null> {
    try {
      const streams = await this.getStreams(token, trackUrn, params);
      const urlKey = `${format}_url` as keyof typeof streams;

      const fallbackOrder: (keyof ScStreams)[] = [
        'hls_aac_160_url',
        'http_mp3_128_url',
        'hls_mp3_128_url',
      ];

      const candidates: { key: keyof ScStreams; url: string }[] = [];
      const requestedUrl = streams[urlKey] as string | undefined;
      if (requestedUrl) {
        candidates.push({ key: urlKey as keyof ScStreams, url: requestedUrl });
      }
      for (const key of fallbackOrder) {
        if (streams[key] && key !== urlKey) {
          candidates.push({ key, url: streams[key] as string });
        }
      }

      if (!candidates.length) return null;

      for (const { key, url } of candidates) {
        const fmt = (key as string).replace('_url', '');
        
        // Восстановлено: Проверка блокировки HQ
        if (fmt === 'hls_aac_160' && Date.now() < this.hqOauthDisabledUntil) {
          continue;
        }

        const isHls = fmt.startsWith('hls_');
        const quality = this.qualityFromStreamKey(key);

        try {
          if (isHls) {
            const result = await streamFromHls(
              this.httpService,
              this.sc.scApiProxyUrl,
              url,
              this.hlsMimeType(fmt),
            );
            return this.withStreamQuality(result, quality);
          }
          const result = await this.proxyStream(token, url, range);
          return this.withStreamQuality(result, quality);
        } catch (err: unknown) {
          // Восстановлено: Обработка 401 ошибки для HQ формата
          const status = this.extractHttpStatus(err);
          const message = err instanceof Error ? err.message : String(err);
          
          if (fmt === 'hls_aac_160' && status === 401) {
            this.hqOauthDisabledUntil = Date.now() + 10 * 60 * 1000;
            this.logger.warn('Stream format hls_aac_160 returned 401, temporarily disabling OAuth HQ stream');
            continue;
          }
          
          this.logger.warn(`Stream format ${fmt} failed: ${message}, trying next...`);
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private qualityFromStreamKey(key: keyof ScStreams): 'hq' | 'lq' {
    return key === 'hls_aac_160_url' ? 'hq' : 'lq';
  }

  private withStreamQuality(
    result: { stream: Readable; headers: Record<string, string> },
    quality: 'hq' | 'lq',
  ): { stream: Readable; headers: Record<string, string> } {
    return {
      ...result,
      headers: {
        ...result.headers,
        'x-stream-quality': quality,
      },
    };
  }

  private hlsMimeType(format: string): string {
    if (format.includes('aac')) return 'audio/mp4; codecs="mp4a.40.2"';
    if (format.includes('opus')) return 'audio/ogg; codecs="opus"';
    return 'audio/mpeg';
  }

  private extensionFromMime(mime: string): string {
    if (mime.includes('ogg')) return 'ogg';
    if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
    if (mime.includes('wav')) return 'wav';
    return 'mp3';
  }

  private async readStreamToBuffer(stream: Readable, maxBytes = 40 * 1024 * 1024): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        throw new BadGatewayException('Audio is too large for Qwen aligner upload');
      }
      chunks.push(buffer);
    }

    return Buffer.concat(chunks);
  }

  // Восстановлено: Метод извлечения HTTP статуса
  private extractHttpStatus(err: unknown): number | null {
    if (!err || typeof err !== 'object') return null;
    const maybeStatus = (err as { status?: unknown }).status;
    if (typeof maybeStatus === 'number') return maybeStatus;

    const responseStatus = (err as { response?: { status?: unknown } }).response?.status;
    return typeof responseStatus === 'number' ? responseStatus : null;
  }

  async getCookieStream(
    trackUrn: string,
  ): Promise<{ stream: Readable; headers: Record<string, string> } | null> {
    if (!this.scPublicCookies.hasCookies) return null;
    try {
      return (await this.scPublicCookies.getStreamViaCookies(trackUrn)) as {
        stream: Readable;
        headers: Record<string, string>;
      } | null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Cookie stream failed for ${trackUrn}: ${message}`);
      return null;
    }
  }

  async getPublicStream(
    trackUrn: string,
    format?: string,
  ): Promise<{ stream: Readable; headers: Record<string, string> } | null> {
    try {
      return await this.scPublicAnon.getStreamForTrack(trackUrn, format);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Public API fallback failed for ${trackUrn}: ${message}`);
      return null;
    }
  }

  getComments(
    token: string,
    trackUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScComment>> {
    return this.sc.apiGet(`/tracks/${trackUrn}/comments`, token, params);
  }

  createComment(
    token: string,
    trackUrn: string,
    body: { comment: { body: string; timestamp?: number } },
  ): Promise<ScComment> {
    return this.sc.apiPost(`/tracks/${trackUrn}/comments`, token, body);
  }

  getFavoriters(
    token: string,
    trackUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScUser>> {
    return this.sc.apiGet(`/tracks/${trackUrn}/favoriters`, token, params);
  }

  getReposters(
    token: string,
    trackUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScUser>> {
    return this.sc.apiGet(`/tracks/${trackUrn}/reposters`, token, params);
  }

  getRelated(
    token: string,
    trackUrn: string,
    params?: Record<string, unknown>,
  ): Promise<ScPaginatedResponse<ScTrack>> {
    return this.sc.apiGet(`/tracks/${trackUrn}/related`, token, params);
  }
}
