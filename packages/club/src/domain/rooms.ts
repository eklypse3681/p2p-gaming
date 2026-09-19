import type { Room, TableTemplate } from '@bgf/protocol';
import { generateId } from '@bgf/protocol';
import { ClubError } from './identity.js';
import type { ClubState } from './state.js';
import { PLATFORM_MIN_RAKE_BPS } from '../platform.js';

/** What the runtime knows about each game, so templates can be validated without the engines. */
export interface GameRegistry {
  [game: string]: {
    minSeats: number;
    maxSeats: number;
    /** Normalise/validate a game config; throw for a bad one. */
    normalizeConfig?: (raw: unknown) => unknown;
  };
}

export function validateTemplate(template: TableTemplate, games: GameRegistry): TableTemplate {
  const game = games[template.game];
  if (!game) throw new ClubError('bad-template', `unknown game ${template.game}`);
  if (!template.name?.trim()) throw new ClubError('bad-template', 'a template needs a name');
  if (
    !Number.isInteger(template.seats) ||
    template.seats < game.minSeats ||
    template.seats > game.maxSeats
  ) {
    throw new ClubError('bad-template', `${template.game} seats ${game.minSeats}–${game.maxSeats}`);
  }
  const stakes = template.stakes;
  if (!stakes || !Number.isInteger(stakes.chipsPerPoint) || stakes.chipsPerPoint < 0) {
    throw new ClubError('bad-template', 'chips per point must be a non-negative integer');
  }
  if (stakes.rake !== undefined) {
    const bps = stakes.rake.basisPoints;
    if (!Number.isInteger(bps) || bps < PLATFORM_MIN_RAKE_BPS) {
      throw new ClubError(
        'bad-template',
        `rake must be at least ${PLATFORM_MIN_RAKE_BPS} basis points`,
      );
    }
    const cap = stakes.rake.cap;
    if (cap !== undefined && (!Number.isInteger(cap) || cap < 0)) {
      throw new ClubError('bad-template', 'rake cap must be a non-negative integer');
    }
  }
  if (stakes.buyIn) {
    const { min, max, default: dflt } = stakes.buyIn;
    if (
      ![min, max, dflt].every((n) => Number.isInteger(n) && n >= 0) ||
      min > max ||
      dflt < min ||
      dflt > max
    ) {
      throw new ClubError('bad-template', 'buy-in bounds must satisfy 0 ≤ min ≤ default ≤ max');
    }
  }
  const config = game.normalizeConfig ? game.normalizeConfig(template.config) : template.config;
  return { ...template, name: template.name.trim(), config };
}

export function findRoom(state: ClubState, roomId: string): Room | undefined {
  return state.rooms.find((r) => r.id === roomId);
}

export function findTemplate(
  state: ClubState,
  templateId: string,
): { room: Room; template: TableTemplate } | undefined {
  for (const room of state.rooms) {
    const template = room.templates.find((t) => t.id === templateId);
    if (template) return { room, template };
  }
  return undefined;
}

export function addRoom(
  state: ClubState,
  input: { name: string; description?: string; id?: string },
): { state: ClubState; room: Room } {
  const name = input.name.trim();
  if (!name) throw new ClubError('bad-room', 'a room needs a name');
  const room: Room = {
    id: input.id ?? generateId(),
    name,
    templates: [],
    ...(input.description ? { description: input.description } : {}),
  };
  return { state: { ...state, rooms: [...state.rooms, room] }, room };
}

export function updateRoom(
  state: ClubState,
  roomId: string,
  patch: Partial<Pick<Room, 'name' | 'description'>>,
): ClubState {
  const room = findRoom(state, roomId);
  if (!room) throw new ClubError('no-room', 'no such room');
  const next: Room = { ...room, ...patch };
  if (!next.name.trim()) throw new ClubError('bad-room', 'a room needs a name');
  return { ...state, rooms: state.rooms.map((r) => (r.id === roomId ? next : r)) };
}

export function removeRoom(state: ClubState, roomId: string): ClubState {
  if (!findRoom(state, roomId)) throw new ClubError('no-room', 'no such room');
  return { ...state, rooms: state.rooms.filter((r) => r.id !== roomId) };
}

export function addTemplate(
  state: ClubState,
  roomId: string,
  input: Omit<TableTemplate, 'id'> & { id?: string },
  games: GameRegistry,
): { state: ClubState; template: TableTemplate } {
  const room = findRoom(state, roomId);
  if (!room) throw new ClubError('no-room', 'no such room');
  const template = validateTemplate({ ...input, id: input.id ?? generateId() }, games);
  const next: Room = { ...room, templates: [...room.templates, template] };
  return {
    state: { ...state, rooms: state.rooms.map((r) => (r.id === roomId ? next : r)) },
    template,
  };
}

export function updateTemplate(
  state: ClubState,
  templateId: string,
  patch: Partial<Omit<TableTemplate, 'id'>>,
  games: GameRegistry,
): ClubState {
  const found = findTemplate(state, templateId);
  if (!found) throw new ClubError('no-template', 'no such template');
  const template = validateTemplate({ ...found.template, ...patch, id: templateId }, games);
  const room: Room = {
    ...found.room,
    templates: found.room.templates.map((t) => (t.id === templateId ? template : t)),
  };
  return { ...state, rooms: state.rooms.map((r) => (r.id === room.id ? room : r)) };
}

export function removeTemplate(state: ClubState, templateId: string): ClubState {
  const found = findTemplate(state, templateId);
  if (!found) throw new ClubError('no-template', 'no such template');
  const room: Room = {
    ...found.room,
    templates: found.room.templates.filter((t) => t.id !== templateId),
  };
  return { ...state, rooms: state.rooms.map((r) => (r.id === room.id ? room : r)) };
}
