import { defineToolkit } from '@ontrove/extend/toolkit';
import { airQualityTool } from './air-quality.js';
import { forecastTool } from './forecast.js';
import { geocodePlaceTool } from './geocode-place.js';
import { historicalTool } from './historical.js';

export default defineToolkit({
  id: 'open-meteo',
  name: 'Open-Meteo Weather',
  description:
    'Global weather: forecasts, current conditions, historical archive (back to 1940), and air quality, from the free Open-Meteo API (no key required).',
  icon: '🌦️',
  version: '1.0.0',
  secrets: [],
  egress: [
    'api.open-meteo.com',
    'geocoding-api.open-meteo.com',
    'air-quality-api.open-meteo.com',
    'archive-api.open-meteo.com',
  ],
  scopes: [],
  visibility: 'public',
  tools: [geocodePlaceTool, forecastTool, airQualityTool, historicalTool],
});
