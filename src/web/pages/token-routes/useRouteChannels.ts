import { useState, useCallback, useRef } from 'react';
import { api } from '../../api.js';
import { normalizeChannels } from './utils.js';
import type { RouteChannel } from './types.js';

function normalizeChannelsWithStableOrder(channels: RouteChannel[], previous?: RouteChannel[]): RouteChannel[] {
  if (!previous || previous.length === 0) return normalizeChannels(channels);

  const previousOrder = new Map(previous.map((channel, index) => [channel.id, index]));
  return [...(channels || [])].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pa - pb;
    const previousA = previousOrder.get(a.id);
    const previousB = previousOrder.get(b.id);
    if (previousA !== undefined && previousB !== undefined) return previousA - previousB;
    if (previousA !== undefined) return -1;
    if (previousB !== undefined) return 1;
    return (a.id ?? 0) - (b.id ?? 0);
  });
}

export function useRouteChannels() {
  const [channelsByRouteId, setChannelsByRouteId] = useState<Record<number, RouteChannel[]>>({});
  const [loadingChannelsByRouteId, setLoadingChannelsByRouteId] = useState<Record<number, boolean>>({});
  const channelsByRouteIdRef = useRef(channelsByRouteId);
  const inflightByRouteIdRef = useRef<Record<number, Promise<RouteChannel[]> | undefined>>({});
  const requestSeqByRouteIdRef = useRef<Record<number, number>>({});
  channelsByRouteIdRef.current = channelsByRouteId;

  const loadChannels = useCallback(async (routeId: number, force = false) => {
    const cached = channelsByRouteIdRef.current[routeId];
    if (!force && cached) return cached;
    if (inflightByRouteIdRef.current[routeId]) return inflightByRouteIdRef.current[routeId];

    const showInitialLoading = !cached;
    if (showInitialLoading) {
      setLoadingChannelsByRouteId((prev) => ({ ...prev, [routeId]: true }));
    }

    const requestSeq = (requestSeqByRouteIdRef.current[routeId] || 0) + 1;
    requestSeqByRouteIdRef.current[routeId] = requestSeq;
    const request = (async () => {
      try {
        const channels = await api.getRouteChannels(routeId);
        const sorted = normalizeChannelsWithStableOrder(channels || [], channelsByRouteIdRef.current[routeId]);
        setChannelsByRouteId((prev) => ({ ...prev, [routeId]: sorted }));
        return sorted;
      } catch (error) {
        console.error(`Failed to load channels for route ${routeId}:`, error);
        throw error;
      } finally {
        if (requestSeqByRouteIdRef.current[routeId] === requestSeq) {
          delete inflightByRouteIdRef.current[routeId];
          delete requestSeqByRouteIdRef.current[routeId];
        }
        if (showInitialLoading) {
          setLoadingChannelsByRouteId((prev) => ({ ...prev, [routeId]: false }));
        }
      }
    })();

    inflightByRouteIdRef.current[routeId] = request;
    return request;
  }, []);

  const invalidateChannels = useCallback((routeId?: number) => {
    setChannelsByRouteId((prev) => {
      if (routeId === undefined) {
        return {};
      }
      const next = { ...prev };
      delete next[routeId];
      return next;
    });
  }, []);

  const setChannels = useCallback((routeId: number, channels: RouteChannel[]) => {
    setChannelsByRouteId((prev) => ({ ...prev, [routeId]: channels }));
  }, []);

  return {
    channelsByRouteId,
    loadingChannelsByRouteId,
    loadChannels,
    invalidateChannels,
    setChannels,
  };
}
