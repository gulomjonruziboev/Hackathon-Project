'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/types';
import { ErrorNotice, Notice } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; requestId?: string | null } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post<Me>('/auth/login', { email, password });
      router.replace('/patients');
    } catch (err) {
      // UI-01: one generic message — the server never says which half was wrong.
      if (err instanceof ApiError) setError({ code: err.code, message: err.message, requestId: err.requestId });
      else setError({ code: 'NETWORK', message: 'Serverga ulanib bo‘lmadi.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 460, paddingTop: 48 }}>
      <h1>TwinRx</h1>
      <Notice>
        <strong>Demo muhiti.</strong> Faqat sintetik bemor ma’lumotlari bilan ishlaydi. Haqiqiy bemor ma’lumotini
        kiritmang.
      </Notice>

      <form className="card" onSubmit={submit} noValidate>
        <h2>Kirish</h2>
        <ErrorNotice error={error} />

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Parol</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button type="submit" disabled={busy}>
          {busy ? 'Tekshirilmoqda…' : 'Kirish'}
        </button>

        <p className="muted-text" style={{ marginTop: 12 }}>
          Ochiq ro‘yxatdan o‘tish yo‘q. Demo hisoblar seed orqali yaratiladi; parollar `.env` faylida saqlanadi.
        </p>
      </form>
    </div>
  );
}
