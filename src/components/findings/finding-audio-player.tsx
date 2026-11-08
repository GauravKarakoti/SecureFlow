"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Play, Pause, Volume2, Sparkles, Loader2, FastForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface FindingAudioPlayerProps {
  findingId: string;
  findingType?: string;
  severity?: string;
  autoFetch?: boolean;
  className?: string;
  onClose?: () => void;
}

const PLAYBACK_SPEEDS = [1, 1.25, 1.5] as const;
type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

// Fixed height patterns for the mini waveform visualizer
const WAVEFORM_HEIGHTS = [35, 60, 45, 90, 70, 50, 85, 100, 75, 40, 80, 65, 90, 45, 60, 30];

export function FindingAudioPlayer({
  findingId,
  findingType,
  severity,
  autoFetch: initialAutoFetch = false,
  className,
}: FindingAudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1);
  const [autoFetchEnabled, setAutoFetchEnabled] = useState(initialAutoFetch);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);

  const audioUrl = `/api/findings/${findingId}/audio-debrief`;

  // Safely cleanup audio element when navigating away or unmounting
  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      audioRef.current = null;
    }
    setIsPlaying(false);
    setIsBuffering(false);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    return () => {
      cleanupAudio();
    };
  }, [cleanupAudio]);

  // Initialize or retrieve the audio element
  const getOrCreateAudio = useCallback(() => {
    if (audioRef.current) return audioRef.current;

    const audio = new Audio();
    audio.preload = autoFetchEnabled ? "auto" : "none";
    audio.src = audioUrl;

    audio.addEventListener("loadstart", () => {
      setIsLoading(true);
      setError(null);
    });

    audio.addEventListener("loadedmetadata", () => {
      if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
      setIsLoading(false);
    });

    audio.addEventListener("canplay", () => {
      setIsLoading(false);
      setIsBuffering(false);
    });

    audio.addEventListener("waiting", () => {
      setIsBuffering(true);
    });

    audio.addEventListener("playing", () => {
      setIsLoading(false);
      setIsBuffering(false);
      setIsPlaying(true);
    });

    audio.addEventListener("pause", () => {
      setIsPlaying(false);
    });

    audio.addEventListener("ended", () => {
      setIsPlaying(false);
      setCurrentTime(0);
    });

    audio.addEventListener("timeupdate", () => {
      if (!isDraggingRef.current) {
        setCurrentTime(audio.currentTime);
        if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
          setDuration(audio.duration);
        }
      }
    });

    audio.addEventListener("error", () => {
      setIsLoading(false);
      setIsBuffering(false);
      setIsPlaying(false);
      setError("Failed to stream audio debrief.");
    });

    audioRef.current = audio;
    return audio;
  }, [audioUrl, autoFetchEnabled]);

  // Handle auto-fetch background preloading
  useEffect(() => {
    if (autoFetchEnabled && !audioRef.current) {
      const audio = getOrCreateAudio();
      audio.load();
    }
  }, [autoFetchEnabled, getOrCreateAudio]);

  const togglePlayPause = async () => {
    try {
      const audio = getOrCreateAudio();
      if (isPlaying) {
        audio.pause();
      } else {
        setError(null);
        audio.playbackRate = playbackSpeed;
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          await playPromise;
        }
      }
    } catch (err) {
      console.warn("[AUDIO_PLAYER] Playback failed:", err);
      setIsPlaying(false);
      setIsBuffering(false);
      setIsLoading(false);
      setError("Could not start audio playback.");
    }
  };

  const handleCycleSpeed = () => {
    const currentIndex = PLAYBACK_SPEEDS.indexOf(playbackSpeed);
    const nextSpeed = PLAYBACK_SPEEDS[(currentIndex + 1) % PLAYBACK_SPEEDS.length];
    setPlaybackSpeed(nextSpeed);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextSpeed;
    }
  };

  const seekTo = (newTime: number) => {
    const clamped = Math.max(0, Math.min(duration, newTime));
    setCurrentTime(clamped);
    if (audioRef.current) {
      audioRef.current.currentTime = clamped;
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressBarRef.current || duration <= 0) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(pos * duration);
  };

  // ARIA sliders must be keyboard-operable: arrows step, Home/End jump.
  const handleSeekKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    const step = Math.max(1, duration / 20); // 5% steps, at least 1s
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      seekTo(currentTime - step);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      seekTo(currentTime + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      seekTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      seekTo(duration);
    }
  };

  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || !isFinite(seconds) || seconds <= 0) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      className={cn(
        "rounded-xl border border-primary/20 bg-black/40 p-3.5 backdrop-blur-md shadow-md transition-all duration-200",
        className,
      )}
      data-testid="finding-audio-player"
    >
      {/* Top Header / Metadata bar */}
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 border border-primary/20 text-primary">
            <Volume2 className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-foreground tracking-tight">
                AI Audio Debrief
              </span>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-4 border-primary/30 bg-primary/5 text-primary"
              >
                <Sparkles className="w-2.5 h-2.5 mr-1" /> ElevenLabs
              </Badge>
            </div>
            {findingType && (
              <span className="text-[10px] text-muted-foreground block truncate max-w-[200px]">
                {severity ? `${severity} • ` : ""}
                {findingType}
              </span>
            )}
          </div>
        </div>

        {/* Auto-Fetch Toggle */}
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="text-[10px]">Auto-debrief</span>
          <Switch
            checked={autoFetchEnabled}
            onCheckedChange={(checked) => setAutoFetchEnabled(checked)}
            aria-label="Toggle auto-fetch debrief"
            className="scale-75"
          />
        </div>
      </div>

      {/* Loading Skeleton during initial load/buffering */}
      {isLoading && !isPlaying ? (
        <div className="space-y-2 py-1">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-full bg-primary/20" />
            <Skeleton className="h-6 flex-1 bg-white/5 rounded-md" />
          </div>
          <div className="flex justify-between">
            <Skeleton className="h-3 w-12 bg-white/5 rounded" />
            <Skeleton className="h-3 w-12 bg-white/5 rounded" />
          </div>
        </div>
      ) : (
        /* Player Controls & Waveform */
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            {/* Play/Pause Button */}
            <Button
              size="sm"
              variant="outline"
              onClick={togglePlayPause}
              disabled={isLoading && !isPlaying}
              className="h-8 w-8 rounded-full p-0 border-primary/30 hover:border-primary hover:bg-primary/10 shrink-0"
              aria-label={isPlaying ? "Pause audio debrief" : "Play audio debrief"}
            >
              {isBuffering ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : isPlaying ? (
                <Pause className="h-4 w-4 fill-primary text-primary" />
              ) : (
                <Play className="h-4 w-4 fill-primary text-primary ml-0.5" />
              )}
            </Button>

            {/* Mini Audio Waveform Visualizer & Scrub Bar */}
            <div className="flex-1 space-y-1">
              <div
                ref={progressBarRef}
                onClick={handleSeek}
                onKeyDown={handleSeekKeyDown}
                tabIndex={0}
                className="group relative flex h-7 items-center cursor-pointer select-none"
                role="slider"
                aria-label="Audio scrubber"
                aria-valuemin={0}
                aria-valuemax={duration || 100}
                aria-valuenow={currentTime}
              >
                {/* Visual Waveform bars */}
                <div className="flex items-center justify-between w-full h-5 gap-[2px] px-1">
                  {WAVEFORM_HEIGHTS.map((height, i) => {
                    const barPos = (i / WAVEFORM_HEIGHTS.length) * 100;
                    const isPassed = barPos <= progressPercent;
                    // Deterministic wave modulation based on currentTime & bar index (pure during render)
                    const waveFactor = 0.6 + ((Math.sin(currentTime * 8 + i * 1.5) + 1) / 2) * 0.4;
                    const activeHeight = Math.max(25, Math.round(height * waveFactor));

                    return (
                      <div
                        key={i}
                        className={cn(
                          "w-1 rounded-full transition-all duration-150",
                          isPassed ? "bg-primary" : "bg-white/15",
                          isPlaying && !isBuffering && "group-hover:opacity-90",
                          isPlaying && !isBuffering && i % 2 === 0 && "animate-pulse duration-700",
                        )}
                        style={{
                          height: isPlaying && !isBuffering ? `${activeHeight}%` : `${height}%`,
                        }}
                      />
                    );
                  })}
                </div>

                {/* Scrubber track background */}
                <div className="absolute inset-x-0 bottom-0 h-1 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-100"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>

              {/* Time displays and Speed selector */}
              <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground px-1">
                <span>{formatTime(currentTime)}</span>
                <div className="flex items-center gap-2">
                  {isBuffering && (
                    <span className="text-[10px] text-amber-400 font-sans flex items-center gap-1">
                      <Loader2 className="w-2.5 h-2.5 animate-spin" /> Buffering...
                    </span>
                  )}
                  <span>{formatTime(duration)}</span>
                </div>
              </div>
            </div>

            {/* Playback Speed control */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCycleSpeed}
              className="h-7 px-2 text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-white/5 shrink-0"
              title="Change playback speed"
            >
              <FastForward className="w-3 h-3 mr-1" />
              {playbackSpeed}x
            </Button>
          </div>

          {/* Error Message */}
          {error && (
            <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-2 py-1">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default FindingAudioPlayer;
