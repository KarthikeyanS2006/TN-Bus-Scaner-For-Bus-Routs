/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChangeEvent } from 'react';
import { useState, useEffect, useRef } from 'react';
import { 
  Camera, 
  History, 
  Activity, 
  ShieldCheck, 
  AlertCircle,
  Bus,
  ScanLine,
  LayoutDashboard,
  Clock,
  Terminal as TerminalIcon,
  Database,
  CheckCircle2,
  Cpu,
  Video,
  VideoOff,
  Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { extractTransitData } from './services/geminiService';
import { TransitMetadata } from './types';

export default function App() {
  const [fullImage, setFullImage] = useState<string | null>(null);
  const [plateCrop, setPlateCrop] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<TransitMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<TransitMetadata & { timestamp: number }>>([]);
  const [systemTime, setSystemTime] = useState(new Date());

  // Camera States
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isCameraLoading, setIsCameraLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Auto Inference States
  const [isAutoInference, setIsAutoInference] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [detector, setDetector] = useState<cocoSsd.ObjectDetection | null>(null);
  const lastTriggeredRef = useRef<number>(0);
  const detectionLoopRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setSystemTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Sync stream to video element
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.onloadedmetadata = () => {
        videoRef.current?.play().catch(e => console.error("Playback failed", e));
      };
    } else if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [stream]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [stream]);

  const toggleCamera = async () => {
    if (isCameraLoading) return;
    
    setIsCameraLoading(true);
    setError(null);

    try {
      if (isCameraActive || stream) {
        // Force stop all tracks
        stream?.getTracks().forEach(track => {
          track.stop();
          console.log(`Stopped track: ${track.label}`);
        });
        setStream(null);
        setIsCameraActive(false);
        setIsCameraLoading(false);
        return;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("API_NOT_FOUND: Browser does not support camera access or is not in a secure context.");
      }

      // Final cleanup check before new stream
      const constraints = { 
        video: { 
          width: { ideal: 1280 }, 
          height: { ideal: 720 },
          facingMode: 'environment'
        } 
      };

      let newStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        console.warn("Retrying with default camera due to constraint error", e);
        newStream = await navigator.mediaDevices.getUserMedia({ video: true });
      }

      setStream(newStream);
      setIsCameraActive(true);
    } catch (err: any) {
      console.error("Camera access error:", err);
      let msg = "Failed to access sensor.";
      if (err.name === 'NotReadableError' || err.message?.includes('in use')) {
        msg = "Camera is already in use by another application or tab. Please close other camera instances.";
      } else if (err.name === 'NotAllowedError') {
        msg = "Camera permission denied. Please enable access in browser settings.";
      }
      setError(`CAMERA_ERROR: ${msg}`);
      setIsCameraActive(false);
    } finally {
      setIsCameraLoading(false);
    }
  };

  const captureSnapshot = (type: 'full' | 'crop') => {
    if (!videoRef.current || !canvasRef.current) return null;
    
    const context = canvasRef.current.getContext('2d');
    if (!context) return null;
    
    // Set canvas dimensions to match video
    canvasRef.current.width = videoRef.current.videoWidth;
    canvasRef.current.height = videoRef.current.videoHeight;
    
    // Draw current frame
    context.drawImage(videoRef.current, 0, 0);
    
    // Export base64
    const dataUrl = canvasRef.current.toDataURL('image/jpeg');
    if (type === 'full') setFullImage(dataUrl);
    else setPlateCrop(dataUrl);
    
    setError(null);
    return dataUrl;
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>, type: 'full' | 'crop') => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      if (type === 'full') setFullImage(reader.result as string);
      else setPlateCrop(reader.result as string);
    };
    reader.readAsDataURL(file);
    setError(null);
  };

  const processImages = async (customFull?: string, customPlate?: string) => {
    const wideImage = customFull || fullImage;
    const cropImage = customPlate || plateCrop;

    if (!wideImage || !cropImage) return;
    
    setIsProcessing(true);
    setResult(null);
    setError(null);

    try {
      const data = await extractTransitData(wideImage, cropImage);
      setResult(data);
      setHistory(prev => [{ ...data, timestamp: Date.now() }, ...prev].slice(0, 10));
      
      // Push newest data to the server for the /json endpoint
      try {
        await fetch('/api/results', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
      } catch (e) {
        console.error("Failed to sync with server API", e);
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || "An unexpected error occurred during analysis.");
    } finally {
      setIsProcessing(false);
    }
  };

  // Load Cocoa SSD Model
  useEffect(() => {
    async function loadModel() {
      setIsModelLoading(true);
      try {
        await tf.ready();
        const model = await cocoSsd.load();
        setDetector(model);
      } catch (err) {
        console.error("Failed to load detector", err);
      } finally {
        setIsModelLoading(false);
      }
    }
    loadModel();
  }, []);

  // Detection Loop
  useEffect(() => {
    if (isAutoInference && isCameraActive && detector && videoRef.current) {
      const runDetection = async () => {
        if (!videoRef.current || !detector || !isAutoInference) return;

        try {
          const predictions = await detector.detect(videoRef.current);
          const bus = predictions.find(p => (p.class === 'bus' || p.class === 'truck') && p.score > 0.65);

          if (bus && Date.now() - lastTriggeredRef.current > 12000) { // 12s cooldown
            console.log("Bus detected! Triggering auto-capture...", bus);
            lastTriggeredRef.current = Date.now();
            
            // Auto Capture
            const freshFull = captureSnapshot('full');
            const freshPlate = captureSnapshot('crop');
            
            // Auto Extract immediately with the fresh data
            if (freshFull && freshPlate) {
              processImages(freshFull, freshPlate);
            }
          }
        } catch (err) {
          console.error("Detection error:", err);
        }

        if (isAutoInference) {
          detectionLoopRef.current = requestAnimationFrame(runDetection);
        }
      };
      
      detectionLoopRef.current = requestAnimationFrame(runDetection);
    } else {
      if (detectionLoopRef.current) cancelAnimationFrame(detectionLoopRef.current);
    }

    return () => {
      if (detectionLoopRef.current) cancelAnimationFrame(detectionLoopRef.current);
    };
  }, [isAutoInference, isCameraActive, detector]);

  return (
    <div className="flex h-screen bg-[#f1f5f9] overflow-hidden font-sans">
      {/* Sidebar / Configuration Panel */}
      <aside className="w-[340px] border-r border-slate-200 bg-white flex flex-col shadow-sm z-10">
        <div className="p-4 border-b border-slate-100 bg-slate-50/50">
          <h1 className="text-lg font-bold text-slate-800 flex items-center">
            <span className="bg-blue-600 text-white p-1.5 rounded-lg mr-3 shadow-md shadow-blue-200">
              <ShieldCheck className="w-5 h-5" />
            </span>
            TN Transit AI
          </h1>
        </div>

        <div className="p-5 space-y-6 flex-1 overflow-y-auto">
          {/* Live Sensor Feed (Viewfinder) */}
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                <Video className="w-3.5 h-3.5" />
                Live Sensor Node
              </label>
              <button 
                onClick={toggleCamera}
                className={`text-[10px] px-2 py-1 rounded font-bold uppercase transition-colors ${isCameraActive ? 'bg-red-50 text-red-600 border border-red-100' : 'bg-emerald-50 text-emerald-600 border border-emerald-100'}`}
              >
                {isCameraActive ? 'Disable Feed' : 'Enable Feed'}
              </button>
            </div>
            
            <div className={`relative aspect-video rounded-xl bg-slate-900 border border-slate-800 overflow-hidden shadow-inner group ${!isCameraActive && 'opacity-50'}`}>
              <video 
                ref={videoRef} 
                autoPlay 
                playsInline 
                muted 
                className={`w-full h-full object-cover transition-opacity duration-700 ${isCameraActive ? 'opacity-100' : 'opacity-0'}`}
              />
              {!isCameraActive && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <VideoOff className="w-8 h-8 text-slate-700" />
                </div>
              )}
              {isCameraActive && (
                <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/80 to-transparent flex gap-2">
                  <button 
                    onClick={() => captureSnapshot('full')}
                    className="flex-1 bg-white/20 hover:bg-white/30 backdrop-blur-md text-white text-[9px] font-bold py-1.5 rounded border border-white/10 uppercase transition-all flex items-center justify-center gap-1"
                  >
                    <Zap className="w-3 h-3" /> Snap Wide
                  </button>
                  <button 
                    onClick={() => captureSnapshot('crop')}
                    className="flex-1 bg-white/20 hover:bg-white/30 backdrop-blur-md text-white text-[9px] font-bold py-1.5 rounded border border-white/10 uppercase transition-all flex items-center justify-center gap-1"
                  >
                    <Camera className="w-3 h-3" /> Snap Crop
                  </button>
                </div>
              )}
              {/* Hidden Canvas for capture */}
              <canvas ref={canvasRef} className="hidden" />
            </div>
          </div>

          <div className="h-px bg-slate-100" />

          {/* Input Buffer */}
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
              <ScanLine className="w-3.5 h-3.5" />
              Neural Input Buffer
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className={`relative group cursor-pointer border-2 border-dashed rounded-xl overflow-hidden transition-all h-28 flex items-center justify-center ${fullImage ? 'border-blue-500 bg-blue-50/10' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`}>
                <input type="file" className="hidden" onChange={(e) => handleFileUpload(e, 'full')} accept="image/*" />
                {fullImage ? (
                  <img src={fullImage} className="w-full h-full object-cover" alt="Full view" />
                ) : (
                  <div className="flex flex-col items-center">
                    <Bus className="w-6 h-6 text-slate-300 mb-1" />
                    <span className="text-[9px] font-bold text-slate-400">WIDE_VIEW</span>
                  </div>
                )}
              </label>

              <label className={`relative group cursor-pointer border-2 border-dashed rounded-xl overflow-hidden transition-all h-28 flex items-center justify-center ${plateCrop ? 'border-blue-500 bg-blue-50/10' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`}>
                <input type="file" className="hidden" onChange={(e) => handleFileUpload(e, 'crop')} accept="image/*" />
                {plateCrop ? (
                  <img src={plateCrop} className="w-full h-full object-cover" alt="Plate crop" />
                ) : (
                  <div className="flex flex-col items-center">
                    <Camera className="w-6 h-6 text-slate-300 mb-1" />
                    <span className="text-[9px] font-bold text-slate-400">CROP_64X</span>
                  </div>
                )}
              </label>
            </div>
          </div>

          {/* Model Params */}
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
              <Cpu className="w-3.5 h-3.5" />
              Machine Intelligence
            </label>
            <div className="space-y-4 bg-slate-50 p-4 rounded-xl border border-slate-100">
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-[11px] font-bold text-slate-700">Autonomous Trigger</span>
                  <span className="text-[9px] text-slate-400">Auto-detect buses & extract</span>
                </div>
                <button 
                  onClick={() => setIsAutoInference(!isAutoInference)}
                  disabled={!detector || isModelLoading}
                  className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${isAutoInference ? 'bg-blue-600' : 'bg-slate-200'} ${(!detector || isModelLoading) && 'opacity-50 cursor-not-allowed'}`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${isAutoInference ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              <div>
                <div className="flex justify-between text-[11px] mb-1.5"><span className="text-slate-500">Object Detector</span><span className={`font-bold ${detector ? 'text-emerald-600' : 'text-slate-400'}`}>{isModelLoading ? 'LOADING...' : detector ? 'COCO-SSD READY' : 'OFFLINE'}</span></div>
                <div className="w-full bg-slate-200 rounded-full h-1.5"><div className={`h-1.5 rounded-full transition-all duration-1000 ${detector ? 'bg-emerald-500 w-full' : 'bg-slate-300 w-1/4'}`}></div></div>
              </div>
            </div>
          </div>

          {/* System Instructions Summary */}
          <div className="bg-blue-50/50 p-4 rounded-xl border border-blue-100/50">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-blue-600" />
              <span className="text-[10px] font-bold text-blue-800 uppercase tracking-wide">Validation Active</span>
            </div>
            <p className="text-[10px] text-blue-700 leading-relaxed font-medium">
              OCR extraction filtered for TN registration prefix. Automatic translation enabled for LED signage.
            </p>
          </div>
        </div>

        <div className="p-4 border-t border-slate-100 bg-white">
          <button 
            onClick={processImages}
            disabled={!fullImage || !plateCrop || isProcessing}
            className="w-full bg-slate-900 text-white py-3 rounded-xl text-sm font-semibold shadow-lg hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-300 transition-all flex items-center justify-center gap-2"
          >
            {isProcessing ? (
              <>
                <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1 }} className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full" />
                EXTRACTING...
              </>
            ) : (
              'Run Extraction'
            )}
          </button>
        </div>
      </aside>

      {/* Main Viewport */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top Navigation */}
        <nav className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 shrink-0">
          <div className="flex items-center space-x-8">
            <span className="text-sm font-bold text-slate-900 border-b-2 border-blue-600 h-16 flex items-center">Live Analysis</span>
            <span className="text-sm font-medium text-slate-400 hover:text-slate-600 cursor-pointer">Log Stream</span>
            <a 
              href="/csv" 
              className="text-sm font-medium text-slate-400 hover:text-blue-600 cursor-pointer flex items-center gap-2"
              download
            >
              <Database className="w-3.5 h-3.5" />
              Download Dataset (CSV)
            </a>
          </div>
          <div className="flex items-center space-x-6">
            <div className="hidden xl:flex items-center space-x-3 text-xs text-slate-400 font-mono">
              <Clock className="w-3.5 h-3.5" />
              <span>{systemTime.toLocaleTimeString([], { hour12: false })}</span>
            </div>
            <div className="flex items-center bg-emerald-50 text-emerald-700 px-3 py-1.5 rounded-full text-[10px] font-bold border border-emerald-100">
              <span className="w-2 h-2 bg-emerald-500 rounded-full mr-2 pulse"></span>
              ACTIVE_SEC_04
            </div>
          </div>
        </nav>

        {/* Content Area */}
        <div className="flex-1 p-8 flex gap-8 overflow-hidden min-h-0">
          {/* Left Column: Visual Stream */}
          <div className="flex-1 flex flex-col space-y-6 min-w-0 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden shrink-0 aspect-video relative group">
              <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
                <div className="bg-black/60 backdrop-blur-md text-white text-[10px] px-3 py-1.5 rounded-lg font-mono border border-white/10 uppercase tracking-widest flex items-center gap-2">
                  <Activity className="w-3 h-3 text-emerald-400" />
                  Stream: {isCameraActive ? 'LIVE_SENSOR_0' : 'NODE_01'}
                </div>
                {isCameraActive && (
                  <div className="bg-red-500/80 backdrop-blur-md text-white text-[9px] px-2 py-1 rounded-md font-bold animate-pulse flex items-center gap-1 border border-red-400/50">
                    <div className="w-1.5 h-1.5 bg-white rounded-full" />
                    REC
                  </div>
                )}
                {isAutoInference && (
                  <div className="bg-blue-600/80 backdrop-blur-md text-white text-[9px] px-2 py-1 rounded-md font-bold flex items-center gap-1 border border-blue-400/50">
                    <Cpu className="w-3 h-3" />
                    AUTONOMOUS_ACTIVE
                  </div>
                )}
              </div>

              <div className="absolute top-4 right-4 z-10 flex gap-2">
                <button 
                  onClick={toggleCamera}
                  className={`p-2 rounded-lg backdrop-blur-md border transition-all ${isCameraActive ? 'bg-blue-600/20 border-blue-500/50 text-blue-400' : 'bg-black/40 border-white/10 text-white/50 hover:text-white'}`}
                  title={isCameraActive ? "Deactivate Scanner" : "Activate Local Sensor"}
                >
                  <Video className="w-4 h-4" />
                </button>
              </div>

              {isCameraActive ? (
                <div className="w-full h-full relative group">
                  <video 
                    ref={videoRef} 
                    autoPlay 
                    playsInline 
                    muted 
                    className="w-full h-full object-cover" 
                  />
                  <div className="absolute inset-0 pointer-events-none border-[12px] border-white/5 border-double" />
                  <div className="absolute top-0 left-0 w-full h-0.5 bg-blue-500/30 blur-sm animate-[scan_3s_linear_infinite]" />
                  
                  {/* HUD Overlay */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-48 h-48 border border-white/10 rounded-full flex items-center justify-center">
                      <div className="w-32 h-32 border border-blue-500/20 rounded-full animate-ping" />
                    </div>
                  </div>

                  <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={() => captureSnapshot('full')}
                      className="bg-blue-600 text-white px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition-colors flex items-center gap-2"
                    >
                      <Zap className="w-3 h-3" /> Capture Wide
                    </button>
                    <button 
                      onClick={() => captureSnapshot('crop')}
                      className="bg-slate-900 text-white px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest shadow-lg shadow-black/30 hover:bg-slate-800 transition-colors flex items-center gap-2"
                    >
                      <Camera className="w-3 h-3" /> Capture Crop
                    </button>
                  </div>
                </div>
              ) : fullImage ? (
                <div className="w-full h-full relative">
                  <img src={fullImage} className="w-full h-full object-cover" />
                  <div className="absolute top-1/4 left-1/4 w-1/2 h-1/3 border-2 border-blue-400 rounded-xl bg-blue-400/5 animate-pulse" />
                </div>
              ) : (
                <div className="w-full h-full bg-slate-50 flex flex-col items-center justify-center">
                  <LayoutDashboard className="w-12 h-12 text-slate-200 mb-3" />
                  <p className="text-xs font-bold text-slate-300 uppercase tracking-widest">No Active Stream</p>
                  <button 
                    onClick={toggleCamera}
                    className="mt-4 flex items-center gap-2 bg-white border border-slate-200 px-4 py-2 rounded-lg text-[10px] font-bold text-slate-500 hover:bg-slate-50 transition-colors shadow-sm"
                  >
                    <Video className="w-3.5 h-3.5" /> Initialize Local Sensor
                  </button>
                </div>
              )}
            </div>

            {/* Detail Crops & Metadata History */}
            <div className="grid grid-cols-2 gap-6 shrink-0">
              <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-3 block">Neural Plate Crop</span>
                <div className="h-20 bg-slate-50 rounded-xl border border-dashed border-slate-200 flex items-center justify-center font-mono text-2xl font-bold text-slate-700 tracking-[0.2em] uppercase">
                  {result?.plate || '---- ----'}
                </div>
              </div>
              <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mb-3 block">Signage Context</span>
                <div className="h-20 bg-slate-900 rounded-xl border border-slate-800 flex items-center justify-center px-4">
                  <span className="text-orange-400 font-black text-xl italic tracking-wide truncate">
                    {result ? result.destination : '--- ---'}
                  </span>
                </div>
              </div>
            </div>

            {/* History Feed */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm flex flex-col flex-1 min-h-0">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest flex items-center gap-2">
                  <History className="w-3.5 h-3.5" />
                  Retention Log
                </span>
              </div>
              <div className="space-y-3 overflow-y-auto flex-1 pr-2 scrollbar-hide">
                <AnimatePresence initial={false}>
                  {history.map((item) => (
                    <motion.div 
                      key={item.timestamp}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="p-3.5 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between hover:bg-slate-100 transition-colors group"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center border border-slate-200 shadow-sm text-blue-600 font-bold text-xs uppercase">
                          {item.bus_name ? item.bus_name.slice(0, 2) : item.operator.slice(0, 2)}
                        </div>
                        <div>
                          <div className="text-xs font-bold text-slate-800">
                            {item.plate} {item.bus_name && <span className="text-blue-600 ml-1">({item.bus_name})</span>}
                          </div>
                          <div className="text-[10px] text-slate-500 font-medium">Route {item.route} &rsaquo; {item.destination}</div>
                        </div>
                      </div>
                      <div className="text-[10px] font-mono text-slate-400 flex flex-col items-end">
                        <span>{new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        <span className="text-emerald-500 font-bold opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                          <CheckCircle2 className="w-2.5 h-2.5" /> Saved
                        </span>
                      </div>
                    </motion.div>
                  ))}
                  {history.length === 0 && (
                    <div className="h-full flex items-center justify-center text-slate-300 text-xs font-medium italic">
                      No records in session buffer
                    </div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>

          {/* Right Column: JSON Output & Context */}
          <div className="w-80 flex flex-col space-y-6 shrink-0">
            <div className="bg-[#1e293b] rounded-2xl p-6 flex-1 flex flex-col shadow-2xl border border-slate-800 overflow-hidden">
              <div className="flex justify-between items-center mb-5">
                <span className="text-[10px] font-mono text-slate-500 uppercase flex items-center gap-2">
                  <TerminalIcon className="w-3 h-3 text-blue-400" />
                  JSON Extraction
                </span>
                <span className="text-[9px] px-2 py-0.5 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-md font-bold">MODE: VALIDATED</span>
              </div>
              <div className="flex-1 font-mono text-[11px] leading-relaxed overflow-y-auto scrollbar-hide text-[#38bdf8]">
                {error ? (
                  <div className="text-red-400 space-y-2">
                    <div className="flex items-center gap-2 font-bold mb-1">
                      <AlertCircle className="w-4 h-4" />
                      EXTRACTION_FAILED
                    </div>
                    <pre className="whitespace-pre-wrap text-[10px] bg-red-950/30 p-3 rounded-lg border border-red-900/30">
                      {JSON.stringify({ 
                        status: "error",
                        code: error.split(': ')[0] || "SYS_001",
                        message: error.split(': ')[1] || error
                      }, null, 2)}
                    </pre>
                    <button 
                      onClick={() => setError(null)}
                      className="mt-4 w-full py-2 bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg font-bold text-[9px] uppercase hover:bg-red-500/30 transition-colors"
                    >
                      Clear Error Buffer
                    </button>
                  </div>
                ) : result ? (
                  <pre className="whitespace-pre-wrap">{JSON.stringify(result, null, 2)}</pre>
                ) : (
                  <div className="text-slate-600 italic">Waiting for extraction trigger...</div>
                )}
              </div>
              <div className="mt-6 pt-5 border-t border-slate-800/50">
                <div className="text-[9px] text-slate-500 font-bold uppercase mb-3 flex items-center gap-2">
                  <Database className="w-3 h-3" />
                  Database Sync
                </div>
                <div className="flex items-center text-[10px] text-emerald-400 font-bold">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-2" /> 
                  Connected to Production Node
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm">
              <div className="text-[10px] font-bold text-slate-800 mb-3 uppercase tracking-widest flex items-center gap-2">
                <AlertCircle className="w-3.5 h-3.5 text-blue-500" />
                Regional Context
              </div>
              <div className="text-[11px] text-slate-500 leading-relaxed font-medium">
                District codes <span className="text-blue-600 font-bold underline decoration-blue-200 underline-offset-2">01 to 99</span> are prioritized. Low-light neural enhancement active for midnight operations.
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
