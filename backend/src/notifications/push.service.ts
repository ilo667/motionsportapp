import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  url?: string;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private initialized = false;

  private ensureInit() {
    if (this.initialized) return;
    const subject = process.env.VAPID_SUBJECT;
    const pubKey = process.env.VAPID_PUBLIC_KEY;
    const privKey = process.env.VAPID_PRIVATE_KEY;
    if (subject && pubKey && privKey) {
      webpush.setVapidDetails(subject, pubKey, privKey);
      this.initialized = true;
    }
  }

  async send(
    sub: { endpoint: string; p256dh: string; auth: string },
    payload: PushPayload,
  ): Promise<'ok' | 'expired' | 'error'> {
    this.ensureInit();
    if (!this.initialized) {
      this.logger.warn('VAPID not configured, skipping push');
      return 'error';
    }
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 3600 },
      );
      return 'ok';
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return 'expired';
      this.logger.error('Push send failed', err);
      return 'error';
    }
  }
}
