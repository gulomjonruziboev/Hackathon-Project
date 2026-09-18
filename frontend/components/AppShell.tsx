'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Capabilities, Me } from '@/lib/types';
import { Badge } from './ui';

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [meRes, capsRes] = await Promise.all([
          api.get<Me>('/auth/me'),
          api.get<Capabilities>('/system/capabilities'),
        ]);
        if (!cancelled) {
          setMe(meRes);
          setCaps(capsRes);
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) router.replace('/login');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function logout() {
    await api.post('/auth/logout');
    router.replace('/login');
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Asosiy mazmunga o‘tish
      </a>
      <header className="topbar">
        <span className="brand">TwinRx</span>
        <nav aria-label="Asosiy">
          <Link href="/patients">Bemorlar</Link>
          <Link href="/system">Tizim holati</Link>
        </nav>
        <span className="spacer" />
        {caps ? (
          <Badge
            label={{
              text: `Qoidalar ${caps.ruleset.version} · ko‘rikdan o‘tgan ${caps.ruleset.reviewed_rule_count}/${caps.ruleset.enabled_rule_count}`,
              glyph: caps.ruleset.reviewed_rule_count > 0 ? '✓' : '⚠',
              className: caps.ruleset.reviewed_rule_count > 0 ? 'badge-ok' : 'badge-moderate',
            }}
          />
        ) : null}
        <Badge label={{ text: 'Sintetik demo', glyph: '⚗', className: 'badge-neutral' }} />
        {me ? (
          <>
            <span className="muted-text">
              {me.user.display_name} · {me.user.clinic.name}
            </span>
            <button type="button" className="secondary" onClick={logout}>
              Chiqish
            </button>
          </>
        ) : null}
      </header>
      <main id="main" className="container">
        {children}
      </main>
    </div>
  );
}
