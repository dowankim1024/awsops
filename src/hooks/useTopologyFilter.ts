'use client';

// Owns the TopologyFilter and keeps it in the URL query string, so a view can be
// shared as a link and back/forward walks through filter states. Every writer
// (checkbox panel, toolbar, chat) goes through `patch` → mergeFilter; the URL is
// only a serialisation of the same object (filterToSearchParams round trip).
// TopologyFilter를 들고 URL 쿼리와 동기화한다. 체크박스·툴바·채팅 모두 patch → mergeFilter를
// 거치고, URL은 같은 객체의 직렬화일 뿐이다.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useSearchParams } from 'next/navigation';

import {
  createDefaultFilter,
  filterFromSearchParams,
  filterToSearchParams,
  mergeFilter,
  type TopologyFilter,
  type TopologyFilterPatch,
} from '@/lib/topology/filter';

export interface TopologyFilterApi {
  filter: TopologyFilter;
  setFilter: Dispatch<SetStateAction<TopologyFilter>>;
  patch: (p: TopologyFilterPatch) => void;
  reset: () => void;
  isDefault: boolean;
  // Absolute URL of the current view (for "copy link"). / 현재 뷰의 절대 URL.
  shareUrl: () => string;
}

export function useTopologyFilter(): TopologyFilterApi {
  // Next 14.1+ syncs useSearchParams with native history.replaceState, so the
  // hook both reads the initial state from the URL and hears back/forward.
  // Next 14.1+는 native replaceState를 라우터와 동기화하므로 초기값과 뒤로/앞으로 모두 여기서 받는다.
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState<TopologyFilter>(() => filterFromSearchParams(searchParams));

  // The query string this hook last wrote or read. Anything else in
  // searchParams is an external change (navigation) and is parsed back in.
  // 이 훅이 마지막으로 쓰거나 읽은 쿼리 문자열. 다르면 외부 변경(내비게이션)이다.
  const synced = useRef(searchParams.toString());

  useEffect(() => {
    const incoming = searchParams.toString();
    if (incoming === synced.current) return;
    synced.current = incoming;
    setFilter(filterFromSearchParams(searchParams));
  }, [searchParams]);

  useEffect(() => {
    const next = filterToSearchParams(filter).toString();
    if (next === synced.current) return;
    synced.current = next;
    const url = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', url);
  }, [filter]);

  const patch = useCallback((p: TopologyFilterPatch) => {
    setFilter((prev) => mergeFilter(prev, p));
  }, []);

  const reset = useCallback(() => setFilter(createDefaultFilter()), []);

  const isDefault = useMemo(() => filterToSearchParams(filter).toString() === '', [filter]);

  const shareUrl = useCallback(() => {
    const q = filterToSearchParams(filter).toString();
    return `${window.location.origin}${window.location.pathname}${q ? `?${q}` : ''}`;
  }, [filter]);

  return { filter, setFilter, patch, reset, isDefault, shareUrl };
}
