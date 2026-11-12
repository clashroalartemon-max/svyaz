/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        border: 'var(--border)',
        text: {
          DEFAULT: 'var(--text)',
          muted: 'var(--text-muted)',
        },
        accent: 'var(--accent)',
        danger: 'var(--danger)',
        own: 'var(--own-msg)',
        other: 'var(--other-msg)',
      },
    },
  },
  plugins: [],
};
