import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import {
  MediaStream,
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from 'react-native-webrtc';
import { io, Socket } from 'socket.io-client';

type Status = 'idle' | 'requesting-permissions' | 'connecting' | 'streaming' | 'error';

type SignalDescription = {
  type: 'offer' | 'answer';
  sdp?: string;
};

type SignalCandidate = {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
};

const DEFAULT_SERVER_URL = '';
const TELEMETRY_INTERVAL_MS = 3000;
const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 360;
const VIDEO_FRAME_RATE = 15;

function normalizeServerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function getSocketErrorMessage(
  serverUrl: string,
  error: { message?: string; description?: unknown; context?: unknown },
): string {
  const message = error.message ?? 'error desconocido';
  if (message === 'timeout') {
    return `Tiempo de espera agotado. Verifica que ${serverUrl} sea accesible desde el teléfono.`;
  }

  const description = typeof error.description === 'string' ? ` Detalle: ${error.description}` : '';
  return `No se pudo conectar a ${serverUrl}. Comprueba IP, puerto, firewall y que el servidor use Socket.IO. Error: ${message}.${description}`;
}

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [status, setStatus] = useState<Status>('idle');
  const [statusMessage, setStatusMessage] = useState('Listo para transmitir');
  const [localStreamUrl, setLocalStreamUrl] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const telemetryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const telemetryInFlightRef = useRef(false);
  const pendingCandidatesRef = useRef<SignalCandidate[]>([]);

  const clearTelemetry = useCallback(() => {
    if (telemetryTimerRef.current) {
      clearInterval(telemetryTimerRef.current);
      telemetryTimerRef.current = null;
    }
  }, []);

  const closeConnection = useCallback(() => {
    clearTelemetry();
    socketRef.current?.disconnect();
    socketRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    pendingCandidatesRef.current = [];
    setLocalStreamUrl(null);
    setStatus('idle');
    setStatusMessage('Desconectado');
  }, [clearTelemetry]);

  const sendTelemetry = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket?.connected || telemetryInFlightRef.current) return;

    telemetryInFlightRef.current = true;

    try {
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const { latitude, longitude, speed } = position.coords;
      socket.emit('telemetry', {
        lat: latitude,
        lng: longitude,
        latitude,
        longitude,
        lon: longitude,
        speed: speed ?? 0,
        timestamp: new Date(position.timestamp).toISOString(),
      });
    } catch (error) {
      console.warn('No se pudo obtener la posición GPS', error);
    } finally {
      telemetryInFlightRef.current = false;
    }
  }, []);

  const startTelemetry = useCallback(() => {
    clearTelemetry();
    void sendTelemetry();
    telemetryTimerRef.current = setInterval(() => {
      void sendTelemetry();
    }, TELEMETRY_INTERVAL_MS);
  }, [clearTelemetry, sendTelemetry]);

  const createPeer = useCallback(async (socket: Socket, stream: MediaStream) => {
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ],
    });
    peerRef.current = peer;

    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    peer.onicecandidate = (event: any) => {
      const candidate = event?.candidate;
      if (candidate) {
        socket.emit('ice-candidate', { candidate: candidate.toJSON ? candidate.toJSON() : candidate });
      }
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        setStatus('streaming');
        setStatusMessage('Video y telemetría activos');
      } else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        setStatus('error');
        setStatusMessage(`WebRTC ${peer.connectionState}`);
      }
    };

    const offer = await peer.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await peer.setLocalDescription(offer);
    socket.emit('offer', { offer });
  }, []);

  const requestPermissions = useCallback(async () => {
    const cameraPermission = await mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: VIDEO_WIDTH,
        height: VIDEO_HEIGHT,
        frameRate: VIDEO_FRAME_RATE,
      },
      audio: true,
    });
    cameraPermission.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });

    const foreground = await Location.requestForegroundPermissionsAsync();
    if (foreground.status !== Location.PermissionStatus.GRANTED) {
      cameraPermission.getTracks().forEach((track) => track.stop());
      throw new Error('Se necesita permiso de ubicación en primer plano.');
    }

    const background = await Location.requestBackgroundPermissionsAsync();
    if (background.status !== Location.PermissionStatus.GRANTED) {
      Alert.alert('Ubicación en segundo plano', 'La transmisión seguirá en primer plano. Activa el permiso desde Ajustes para telemetría con la app minimizada.', [
        { text: 'Continuar' },
        { text: 'Abrir ajustes', onPress: () => void Linking.openSettings() },
      ]);
    }
    return cameraPermission;
  }, []);

  const connect = useCallback(async () => {
    if (socketRef.current) return;
    if (!serverUrl.trim()) {
      setStatus('error');
      setStatusMessage('Escribe la IP y puerto del servidor, por ejemplo http://192.168.1.20:8080.');
      return;
    }
    setStatus('requesting-permissions');
    setStatusMessage('Solicitando cámara, micrófono y ubicación...');

    try {
      const normalizedUrl = normalizeServerUrl(serverUrl);
      const stream = await requestPermissions();
      streamRef.current = stream;
      setLocalStreamUrl(stream.toURL());
      setStatus('connecting');
      setStatusMessage('Conectando con el servidor...');

      const socket = io(normalizedUrl, {
        path: '/socket.io/',
        transports: ['polling', 'websocket'],
        tryAllTransports: true,
        upgrade: true,
        forceNew: true,
        timeout: 10000,
        reconnection: true,
        reconnectionAttempts: 5,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        socket.emit('join', { role: 'transmitter' });
        startTelemetry();
        void createPeer(socket, stream);
        setStatusMessage('Socket conectado, negociando video...');
      });
      socket.on('connect_error', (error) => {
        setStatus('error');
        setStatusMessage(getSocketErrorMessage(normalizeServerUrl(serverUrl), error));
      });
      socket.on('offer', async (payload: { offer?: SignalDescription } | SignalDescription) => {
        const offer =
          typeof payload === 'object' && payload !== null && 'offer' in payload && payload.offer
            ? payload.offer
            : payload;

        if (!offer || !('type' in offer) || !offer.type || !peerRef.current) return;

        await peerRef.current.setRemoteDescription({ type: offer.type, sdp: offer.sdp ?? '' });

        const answer = await peerRef.current.createAnswer();
        await peerRef.current.setLocalDescription(answer);
        socket.emit('answer', { answer });

        for (const candidate of pendingCandidatesRef.current) {
          await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingCandidatesRef.current = [];
      });
      socket.on('answer', async (payload: { answer?: SignalDescription } | SignalDescription) => {
        const answer =
          typeof payload === 'object' && payload !== null && 'answer' in payload && payload.answer
            ? payload.answer
            : payload;

        if (!answer || !('type' in answer) || !answer.type || !peerRef.current) return;

        await peerRef.current.setRemoteDescription({ type: answer.type, sdp: answer.sdp ?? '' });
        for (const candidate of pendingCandidatesRef.current) {
          await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingCandidatesRef.current = [];
      });
      socket.on('ice-candidate', async (payload: { candidate?: SignalCandidate } | SignalCandidate) => {
        const candidate =
          typeof payload === 'object' && payload !== null && 'candidate' in payload && payload.candidate
            ? payload.candidate
            : payload;

        if (!candidate || typeof candidate !== 'object' || !('candidate' in candidate) || !candidate.candidate || !peerRef.current) {
          return;
        }

        if (peerRef.current.remoteDescription) {
          await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate as any));
        } else {
          pendingCandidatesRef.current.push(candidate as SignalCandidate);
        }
      });
    } catch (error) {
      closeConnection();
      setStatus('error');
      setStatusMessage(error instanceof Error ? error.message : 'No se pudo iniciar la transmisión.');
    }
  }, [closeConnection, createPeer, requestPermissions, serverUrl, startTelemetry]);

  useEffect(() => closeConnection, [closeConnection]);

  const isBusy = status === 'requesting-permissions' || status === 'connecting' || status === 'streaming';

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.eyebrow}>BUSES DE AMAGÁ</Text>
        <Text style={styles.title}>Transmisor móvil</Text>
        <Text style={styles.subtitle}>Video en directo y posición del vehículo.</Text>

        <View style={styles.videoFrame}>
          {localStreamUrl ? (
            <RTCView streamURL={localStreamUrl} style={styles.video} objectFit="cover" mirror={false} />
          ) : (
            <Text style={styles.videoPlaceholder}>La cámara trasera aparecerá aquí</Text>
          )}
          <View style={[styles.liveBadge, status === 'streaming' && styles.liveBadgeActive]}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>{status === 'streaming' ? 'EN VIVO' : 'SIN CONEXIÓN'}</Text>
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={styles.label}>IP o URL del servidor</Text>
          <TextInput
            value={serverUrl}
            onChangeText={setServerUrl}
            editable={!isBusy}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="192.168.1.20:8080"
            placeholderTextColor="#718096"
            style={styles.input}
          />
          <Text style={styles.status}>{statusMessage}</Text>
          <Pressable
            onPress={isBusy ? closeConnection : connect}
            disabled={status === 'requesting-permissions'}
            style={({ pressed }) => [styles.button, isBusy && styles.buttonStop, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>{status === 'requesting-permissions' ? 'Solicitando permisos...' : isBusy ? 'Detener transmisión' : 'Conectar y transmitir'}</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#07111f' },
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 24 },
  eyebrow: { color: '#4fd1c5', fontSize: 12, fontWeight: '700', letterSpacing: 2 },
  title: { color: '#f7fafc', fontSize: 32, fontWeight: '800', marginTop: 8 },
  subtitle: { color: '#a0aec0', fontSize: 15, marginTop: 6, marginBottom: 24 },
  videoFrame: { aspectRatio: 16 / 10, backgroundColor: '#111c2d', borderRadius: 14, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#26364e' },
  video: { width: '100%', height: '100%' },
  videoPlaceholder: { color: '#718096', fontSize: 14 },
  liveBadge: { position: 'absolute', top: 12, left: 12, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: '#1a2538' },
  liveBadgeActive: { backgroundColor: '#9b2c2c' },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fc8181', marginRight: 6 },
  liveText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  panel: { marginTop: 20, padding: 18, backgroundColor: '#0d1a2b', borderRadius: 12, borderWidth: 1, borderColor: '#223452' },
  label: { color: '#cbd5e0', fontSize: 13, fontWeight: '700', marginBottom: 8 },
  input: { color: '#f7fafc', backgroundColor: '#07111f', borderWidth: 1, borderColor: '#314665', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15 },
  status: { color: '#a0aec0', fontSize: 13, minHeight: 20, marginTop: 12 },
  button: { backgroundColor: '#319795', borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  buttonStop: { backgroundColor: '#c05621' },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});