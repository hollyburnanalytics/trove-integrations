import { defineToolkit } from '@ontrove/extend/toolkit';
import { getEntityTool } from './get-entity.js';
import { getEntityHistoryTool } from './get-entity-history.js';
import { searchEntitiesTool } from './search-entities.js';

export default defineToolkit({
  id: 'orgbook-bc',
  name: 'OrgBook BC',
  description:
    "Verify BC-registered legal entities in the province's public corporate registry (OrgBook BC) — search by name, look up a registration number, and read an entity's registration/name history. No key needed.",
  icon: '🏛️',
  version: '1.0.0',
  secrets: [],
  scopes: [],
  visibility: 'shared',
  egress: ['orgbook.gov.bc.ca'],
  tools: [searchEntitiesTool, getEntityTool, getEntityHistoryTool],
});
