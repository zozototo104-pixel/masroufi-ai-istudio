import { useState, useEffect, useRef, useCallback } from 'react';
import { pcmToBase64, base64ToPcm, createAudioBuffer } from './audioUtils';

export function useGeminiLive(settings?: { voice: string; persona: string; apiKey: string; idToken: string | null; userName: string; aiName: string; relationship?: string }) {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'listening' | 'thinking' | 'talking'>('idle');

  const wsRef = useRef<WebSocket | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  // Track playback time to schedule consecutive audio chunks properly
  const nextPlayTimeRef = useRef<number>(0);
  // Keep track of active audio source nodes so we can stop them on interrupt
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  // One acknowledgement per connection is enough to prove whether server audio
  // reached the browser and what state Web Audio was in when it arrived.
  const clientAudioAckSentRef = useRef(false);

  const disconnect = useCallback(() => {
    setIsConnected(false);
    setIsRecording(false);
    setStatus('idle');
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    if (inputCtxRef.current) {
      inputCtxRef.current.close();
      inputCtxRef.current = null;
    }
    
    if (outputCtxRef.current) {
      outputCtxRef.current.close();
      outputCtxRef.current = null;
    }
    
    activeSourcesRef.current = [];
  }, []);

  const stopPlayback = useCallback(() => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) { /* ignore */ }
    });
    activeSourcesRef.current = [];
    if (outputCtxRef.current) {
      nextPlayTimeRef.current = outputCtxRef.current.currentTime;
    }
  }, []);

  const connect = useCallback(async (overrideToken?: string) => {
    try {
      setError(null);
      
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let wsUrl = `${protocol}//${window.location.host}/live`;
      
      // V6 (HF-4): token is NOT placed in URL anymore. URL is logged and would leak the token.
      // Non-secret settings still go in URL. Token is sent as the first WS message after open.
      const currentSettings = settingsRef.current;
      const params = new URLSearchParams();
      if (currentSettings?.voice) params.append('voice', currentSettings.voice);
      if (currentSettings?.persona) params.append('persona', currentSettings.persona);
      // Do not put API keys in the WebSocket URL; URLs can be logged by proxies/hosts.
      if (currentSettings?.userName) params.append('userName', currentSettings.userName);
      if (currentSettings?.aiName) params.append('aiName', currentSettings.aiName);
      if (currentSettings?.relationship) params.append('relationship', currentSettings.relationship);
      const activeToken = overrideToken || currentSettings?.idToken;
      // Token deliberately NOT appended to URL.
      
      const queryString = params.toString();
      if (queryString) {
        wsUrl += `?${queryString}`;
      }

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      clientAudioAckSentRef.current = false;

      // Output context for playback (Gemini outputs 24kHz)
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      outputCtxRef.current = outputCtx;
      if (outputCtx.state === 'suspended') await outputCtx.resume();
      nextPlayTimeRef.current = outputCtx.currentTime;

      ws.onopen = async () => {
        // V6: send the auth message FIRST. Server will not process audio until auth_ok arrives.
        if (activeToken) {
          try {
            ws.send(JSON.stringify({ type: 'auth', token: activeToken, apiKey: currentSettings?.apiKey || undefined }));
          } catch (e) {
            console.warn('Failed to send WS auth message:', e);
          }
        } else {
          // No token available — close with a clear error rather than falling back.
          setError('No authentication token available. Please sign in to use voice.');
          try { ws.close(4001, 'no token'); } catch (e) { /* ignore */ }
          return;
        }
        setIsConnected(true);
        setIsRecording(true);
        setStatus('listening');
        
        try {
          // Input context for recording (Gemini needs 16kHz)
          const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
          inputCtxRef.current = inputCtx;
          
          const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            } 
          });
          streamRef.current = stream;
          
          const source = inputCtx.createMediaStreamSource(stream);
          const processor = inputCtx.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;
          
          source.connect(processor);
          processor.connect(inputCtx.destination);
          
          let userSpeechCounter = 0;
          processor.onaudioprocess = (e) => {
            const channelData = e.inputBuffer.getChannelData(0);
            
            // Calculate RMS volume level of user microphone input
            let sumSquares = 0;
            for (let i = 0; i < channelData.length; i++) {
              sumSquares += channelData[i] * channelData[i];
            }
            const rms = Math.sqrt(sumSquares / channelData.length);

            // If AI is currently talking and user speaks into mic (barge-in):
            const isAiTalking = activeSourcesRef.current.length > 0;
            if (isAiTalking) {
              if (rms > 0.04) {
                userSpeechCounter++;
                if (userSpeechCounter >= 2) {
                  // User is actively interrupting: instantly halt audio playback
                  stopPlayback();
                  setStatus('listening');
                  window.dispatchEvent(new CustomEvent('masrofi:user-interrupted'));
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ interrupt: true }));
                    // Send this interrupt voice chunk
                    const base64 = pcmToBase64(channelData);
                    ws.send(JSON.stringify({ audio: base64 }));
                  }
                  userSpeechCounter = 0;
                }
              } else {
                userSpeechCounter = Math.max(0, userSpeechCounter - 1);
              }
              // Do NOT send microphone audio while AI is outputting voice to avoid echo feedback loop
              return;
            } else {
              userSpeechCounter = 0;
            }

            if (ws.readyState === WebSocket.OPEN) {
              const base64 = pcmToBase64(channelData);
              ws.send(JSON.stringify({ audio: base64 }));
            }
          };
        } catch (err: any) {
          setError('Microphone access denied or error occurred.');
          console.error(err);
          disconnect();
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.status) {
          if (msg.status === 'thinking') setStatus('thinking');
          if (msg.status === 'ready') {
            setStatus('listening');
          }
        }

        // The server commonly sends { status: 'ready', refresh: true } together.
        // Dispatch exactly once so one Live tool response cannot trigger two full
        // Firestore refresh cycles on the client.
        if (msg.refresh || msg.status === 'ready') {
          window.dispatchEvent(new CustomEvent('masrofi:refresh'));
        }

        if (msg.audio && outputCtxRef.current) {
          if (!clientAudioAckSentRef.current && ws.readyState === WebSocket.OPEN) {
            clientAudioAckSentRef.current = true;
            ws.send(JSON.stringify({
              type: 'client_audio_ack',
              audioContextState: outputCtxRef.current.state,
              visibilityState: document.visibilityState,
              hasFocus: document.hasFocus(),
            }));
          }
          setStatus('talking');
          // Play audio
          const pcmData = base64ToPcm(msg.audio);
          const buffer = createAudioBuffer(outputCtxRef.current, pcmData);
          
          const source = outputCtxRef.current.createBufferSource();
          source.buffer = buffer;
          source.connect(outputCtxRef.current.destination);
          
          const currentTime = outputCtxRef.current.currentTime;
          // Ensure we don't schedule in the past
          if (nextPlayTimeRef.current < currentTime) {
            nextPlayTimeRef.current = currentTime;
          }
          
          source.start(nextPlayTimeRef.current);
          nextPlayTimeRef.current += buffer.duration;
          
          activeSourcesRef.current.push(source);
          source.onended = () => {
            activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
            if (activeSourcesRef.current.length === 0 && isConnected) {
              setStatus('listening');
            }
          };
        }
        
        if (msg.interrupted) {
          stopPlayback();
          setStatus('listening');
        }
        
        if (msg.error) {
          setError(msg.error);
          setTimeout(() => setError(null), 4000);
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        setIsRecording(false);
        setStatus('idle');
        window.dispatchEvent(new CustomEvent('masrofi:refresh'));
      };

      ws.onerror = (event) => {
        console.warn("WebSocket connection state event:", event);
        disconnect();
        window.dispatchEvent(new CustomEvent('masrofi:refresh'));
      };
      
    } catch (err: any) {
      console.warn("Audio connection error:", err);
      setError(err?.message || 'تعذر بدء الاتصال الصوتي.');
      setTimeout(() => setError(null), 3500);
      disconnect();
    }
  }, [disconnect, stopPlayback]);

  // Clean up on unmount
  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  return {
    connect,
    disconnect,
    isConnected,
    isRecording,
    status,
    error
  };
}
