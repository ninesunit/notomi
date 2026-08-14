/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./app/**/*.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        // Warm "paper" workspace palette.
        paper: '#FAF9F5',
        surface: '#FFFFFF',
        sand: '#F5F3EF',
        line: '#E7E5E4',
        ink: '#18181B',
        muted: '#6F6A5F',
        subtle: '#9A9488',
        accent: '#B4552D',
        'accent-soft': '#F5E5DA',
        pine: '#2E6F5E',
        'pine-soft': '#E1EDE8',
        amber: '#B4832A',
        'amber-soft': '#F7EDD8',
        rose: '#B0443E',
        'rose-soft': '#F7E2E1',
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
