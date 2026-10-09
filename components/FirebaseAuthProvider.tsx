"use client";

import React, { useEffect, useRef, useCallback } from "react";
import { useStudyStore } from "@/store/useStudyStore";
import {
  onFirebaseAuthChange,
  loadUserDataFromFirestore,
  saveUserDataToFirestore,
  isFirebaseConfigured,
  type FirebaseUser,
} from "@/lib/firebase";
import { Playlist, Subject, Lecture, CalendarEvent } from "@/types";
import { toast } from "sonner";

/**
 * Smart merge function: combines cloud data with any local items
 * that were added before the cloud save completed (e.g., if user refreshed immediately).
 */
function mergeLocalAndCloud(cloudData: any) {
  const localState = useStudyStore.getState();

  // 1. Playlists
  const cloudPlaylists: Playlist[] = Array.isArray(cloudData.playlists) ? cloudData.playlists : [];
  const cloudPlIds = new Set(cloudPlaylists.map((p) => p.id));
  const cloudYtIds = new Set(cloudPlaylists.map((p) => p.youtubePlaylistId).filter(Boolean));
  // Keep local playlists not in cloud yet
  const localOnlyPlaylists = localState.playlists.filter(
    (p) => !cloudPlIds.has(p.id) && (!p.youtubePlaylistId || !cloudYtIds.has(p.youtubePlaylistId))
  );
  const mergedPlaylists = [...cloudPlaylists, ...localOnlyPlaylists];

  // 2. Subjects
  const cloudSubjects: Subject[] = Array.isArray(cloudData.subjects) ? cloudData.subjects : [];
  const cloudSubjIds = new Set(cloudSubjects.map((s) => s.id));
  const localOnlySubjects = localState.subjects.filter((s) => !cloudSubjIds.has(s.id));
  const mergedSubjects = [...cloudSubjects, ...localOnlySubjects];

  // 3. Lectures
  const cloudLectures: Lecture[] = Array.isArray(cloudData.lectures) ? cloudData.lectures : [];
  const cloudLecIds = new Set(cloudLectures.map((l) => l.id));
  const localOnlyLectures = localState.lectures.filter((l) => !cloudLecIds.has(l.id));
  const mergedLectures = [...cloudLectures, ...localOnlyLectures];

  // 4. Events
  const cloudEvents: CalendarEvent[] = Array.isArray(cloudData.events) ? cloudData.events : [];
  const cloudEventIds = new Set(cloudEvents.map((e) => e.id));
  const localOnlyEvents = localState.events.filter((e) => !cloudEventIds.has(e.id));
  const mergedEvents = [...cloudEvents, ...localOnlyEvents];

  // 5. Sessions
  const cloudSessions = Array.isArray(cloudData.sessions) ? cloudData.sessions : [];
  const cloudSessionIds = new Set(cloudSessions.map((s: any) => s.id));
  const localOnlySessions = localState.sessions.filter((s) => !cloudSessionIds.has(s.id));
  const mergedSessions = [...cloudSessions, ...localOnlySessions];

  // 6. Threads
  const cloudThreads = Array.isArray(cloudData.threads) ? cloudData.threads : [];
  const cloudThreadIds = new Set(cloudThreads.map((t: any) => t.id));
  const localOnlyThreads = localState.threads.filter((t) => !cloudThreadIds.has(t.id));
  const mergedThreads = [...cloudThreads, ...localOnlyThreads];

  useStudyStore.setState({
    subjects: mergedSubjects,
    playlists: mergedPlaylists,
    lectures: mergedLectures,
    events: mergedEvents,
    sessions: mergedSessions,
    threads: mergedThreads,
    settings: cloudData.settings
      ? { ...localState.settings, ...cloudData.settings }
      : localState.settings,
  });

  return {
    hasNewLocalItems:
      localOnlyPlaylists.length > 0 ||
      localOnlySubjects.length > 0 ||
      localOnlyLectures.length > 0,
  };
}

export function FirebaseAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const login = useStudyStore((s) => s.login);
  const logout = useStudyStore((s) => s.logout);
  const setFirebaseUid = useStudyStore((s) => s.setFirebaseUid);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const currentUidRef = useRef<string | null>(null);
  const isLoadingFromFirestore = useRef(false);
  const hasLoadedInitialData = useRef(false);

  // Immediate save helper
  const saveNow = useCallback(async (uid: string) => {
    if (isLoadingFromFirestore.current) return;
    try {
      const data = useStudyStore.getState().getSyncableData();
      await saveUserDataToFirestore(uid, data);
    } catch (err) {
      console.warn("[Firebase Sync] Save failed:", err);
    }
  }, []);

  // Debounced save to Firestore
  const debouncedSave = useCallback(
    (uid: string) => {
      if (isLoadingFromFirestore.current) return;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        await saveNow(uid);
      }, 600); // 600ms debounce
    },
    [saveNow]
  );

  // Flush any pending save before the user refreshes or leaves
  useEffect(() => {
    const handleBeforeUnload = () => {
      const uid = currentUidRef.current;
      if (uid && !isLoadingFromFirestore.current) {
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        const data = useStudyStore.getState().getSyncableData();
        saveUserDataToFirestore(uid, data).catch(() => {});
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // Listen to Firebase Auth state
  useEffect(() => {
    if (!isFirebaseConfigured()) return;

    const unsubAuth = onFirebaseAuthChange(async (firebaseUser: FirebaseUser | null) => {
      if (firebaseUser) {
        const uid = firebaseUser.uid;
        const prevUid = currentUidRef.current;
        currentUidRef.current = uid;

        // Check if the user changed from what was stored locally
        const storeUid = useStudyStore.getState().firebaseUid;
        if (storeUid && storeUid !== uid) {
          // Different user logged in! Reset state to avoid bleeding data between accounts
          useStudyStore.getState().resetAllData();
        }

        setFirebaseUid(uid);

        // Update user profile in zustand store
        login({
          name: firebaseUser.displayName || firebaseUser.email?.split("@")[0] || "Student",
          email: firebaseUser.email || "",
          avatar: firebaseUser.photoURL || undefined,
        });

        // Load existing data from Firestore
        if (!hasLoadedInitialData.current || prevUid !== uid) {
          try {
            isLoadingFromFirestore.current = true;
            const cloudData = await loadUserDataFromFirestore(uid);

            if (cloudData && Object.keys(cloudData).length > 0) {
              const hasCloudData =
                (cloudData.subjects && cloudData.subjects.length > 0) ||
                (cloudData.playlists && cloudData.playlists.length > 0) ||
                (cloudData.lectures && cloudData.lectures.length > 0);

              if (hasCloudData) {
                // Merge cloud data with any local items, ensuring newly added items aren't lost
                const { hasNewLocalItems } = mergeLocalAndCloud(cloudData);

                // If user had added local items before reload that weren't in cloud yet, save now
                if (hasNewLocalItems) {
                  const updatedData = useStudyStore.getState().getSyncableData();
                  await saveUserDataToFirestore(uid, updatedData);
                }
              } else {
                // Cloud exists but has empty data; if brand new user, start empty
                if (storeUid && storeUid !== uid) {
                  useStudyStore.getState().resetAllData();
                }
              }
            } else {
              // Brand new user with NO data in cloud yet!
              // NEVER copy another user's local data into a new account!
              if (storeUid && storeUid !== uid) {
                useStudyStore.getState().resetAllData();
              } else {
                // If this is the current user's own local unsaved data, backup to cloud
                const localState = useStudyStore.getState();
                if (localState.subjects.length > 0 || localState.playlists.length > 0) {
                  const data = localState.getSyncableData();
                  await saveUserDataToFirestore(uid, data);
                }
              }
            }
            hasLoadedInitialData.current = true;
          } catch (err) {
            console.warn("[Firebase Sync] Load failed:", err);
          } finally {
            isLoadingFromFirestore.current = false;
          }
        }
      } else {
        // User signed out
        currentUidRef.current = null;
        hasLoadedInitialData.current = false;
        if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
        logout();
      }
    });

    return () => {
      unsubAuth();
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [login, logout, setFirebaseUid]);

  // Subscribe to store changes and save to Firestore
  useEffect(() => {
    if (!isFirebaseConfigured()) return;

    const unsub = useStudyStore.subscribe((state, prevState) => {
      const uid = currentUidRef.current;
      if (!uid) return;
      if (isLoadingFromFirestore.current) return;

      // Check if syncable data actually changed
      const changed =
        state.subjects !== prevState.subjects ||
        state.playlists !== prevState.playlists ||
        state.lectures !== prevState.lectures ||
        state.events !== prevState.events ||
        state.sessions !== prevState.sessions ||
        state.threads !== prevState.threads ||
        state.settings !== prevState.settings;

      if (changed) {
        debouncedSave(uid);
      }
    });

    return unsub;
  }, [debouncedSave]);

  return <>{children}</>;
}
