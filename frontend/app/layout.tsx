import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TwinRx — retsept ssenariylarini tekshirish (demo)',
  description:
    'Sintetik bemor profillari bo‘yicha retsept ssenariylarini cheklangan klinik qoidalar bilan tekshirish prototipi.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz">
      <body>{children}</body>
    </html>
  );
}
