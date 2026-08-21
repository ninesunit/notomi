/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./app/**/*.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // Warm "paper" workspace palette, driven by the channel triplets in
        // global.css so the whole app re-themes from one block of variables.
        paper: 'rgb(var(--paper) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        sand: 'rgb(var(--sand) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        subtle: 'rgb(var(--subtle) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-soft': 'rgb(var(--accent-soft) / <alpha-value>)',
        pine: 'rgb(var(--pine) / <alpha-value>)',
        'pine-soft': 'rgb(var(--pine-soft) / <alpha-value>)',
        amber: 'rgb(var(--amber) / <alpha-value>)',
        'amber-soft': 'rgb(var(--amber-soft) / <alpha-value>)',
        rose: 'rgb(var(--rose) / <alpha-value>)',
        'rose-soft': 'rgb(var(--rose-soft) / <alpha-value>)',
        // Fixed in both themes — see the note in global.css.
        scrim: 'rgb(var(--scrim) / <alpha-value>)',
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Inter_400Regular', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        medium: ['Inter_500Medium', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        semibold: ['Inter_600SemiBold', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        bold: ['Inter_700Bold', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        heading: [
          'PlusJakartaSans_600SemiBold',
          'Plus Jakarta Sans',
          'Inter',
          'ui-sans-serif',
          'system-ui',
          'sans-serif',
        ],
        serif: ['ui-serif', 'Iowan Old Style', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};
