import React, { useState, useCallback, useRef } from "react";
import { FaCamera, FaUpload, FaSpinner, FaArrowLeft } from "react-icons/fa";
import GoBoard from "./GoBoard";
import {
  scoreBoardImage,
  fileToBase64,
  type ImageScoringResult,
} from "./imageScoringService";

interface ImageScorerProps {
  onBack: () => void;
}

const ImageScorer: React.FC<ImageScorerProps> = ({ onBack }) => {
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<ImageScoringResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [komi, setKomi] = useState(6.5);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Please upload an image file (JPEG, PNG, etc.).");
      return;
    }
    setImageFile(file);
    setResult(null);
    setError(null);
    const reader = new FileReader();
    reader.onload = (e) => setImagePreview(e.target?.result as string);
    reader.readAsDataURL(file);
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleScore = async () => {
    if (!imageFile) return;
    setIsProcessing(true);
    setError(null);
    setResult(null);

    try {
      const base64 = await fileToBase64(imageFile);
      const scoringResult = await scoreBoardImage(base64, imageFile.type, komi);
      setResult(scoringResult);
    } catch (err: any) {
      setError(err.message || "Failed to analyze image.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReset = () => {
    setImagePreview(null);
    setImageFile(null);
    setResult(null);
    setError(null);
  };

  const noop = () => {};

  return (
    <div className="h-screen bg-slate-950 text-slate-100 font-sans flex flex-col overflow-hidden">
      {/* Header */}
      <header className="h-12 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shadow-md z-20 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 hover:bg-slate-800 text-slate-400 hover:text-white px-2 py-1.5 rounded-lg transition-all text-xs font-semibold"
          >
            <FaArrowLeft size={12} />
            <span className="hidden sm:inline">Editor</span>
          </button>
          <h1 className="text-2xl font-bold italic tracking-tight text-white font-google">
            komi
          </h1>
          <span className="text-xs text-slate-500 font-medium hidden sm:inline">
            / Score from Photo
          </span>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Left: Upload / Image Preview */}
        <div className="flex-1 flex flex-col items-center justify-center p-4 min-w-0">
          {!imagePreview ? (
            <div
              ref={dropRef}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onClick={() => fileInputRef.current?.click()}
              className="w-full max-w-lg aspect-square border-2 border-dashed border-slate-700 rounded-2xl flex flex-col items-center justify-center gap-4 cursor-pointer hover:border-emerald-500 hover:bg-slate-900/50 transition-all"
            >
              <FaCamera className="text-5xl text-slate-600" />
              <div className="text-center">
                <p className="text-lg font-semibold text-slate-400">
                  Upload a board photo
                </p>
                <p className="text-sm text-slate-600 mt-1">
                  Drag & drop or click to browse
                </p>
                <p className="text-xs text-slate-700 mt-2">
                  Take a photo of your finished game and Komi will score it
                </p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileInput}
              />
            </div>
          ) : result ? (
            // Show detected board
            <div className="h-full w-full flex items-center justify-center">
              <GoBoard
                grid={result.grid}
                lastMove={null}
                onIntersectionClick={noop}
              />
            </div>
          ) : (
            // Show image preview
            <div className="w-full max-w-lg flex flex-col items-center gap-4">
              <div className="relative w-full aspect-square rounded-xl overflow-hidden border border-slate-800">
                <img
                  src={imagePreview}
                  alt="Board photo"
                  className="w-full h-full object-contain bg-slate-900"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleReset}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 transition-all"
                >
                  Change Photo
                </button>
                <button
                  onClick={handleScore}
                  disabled={isProcessing}
                  className={`px-6 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2 ${
                    isProcessing
                      ? "bg-emerald-900/50 text-emerald-400/60 cursor-not-allowed"
                      : "bg-emerald-600 hover:bg-emerald-500 text-white"
                  }`}
                >
                  {isProcessing ? (
                    <>
                      <FaSpinner className="animate-spin" />
                      Analyzing...
                    </>
                  ) : (
                    <>
                      <FaUpload size={12} />
                      Score This Game
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right: Results Panel */}
        <div className="w-full md:w-[400px] bg-slate-900 border-t md:border-t-0 md:border-l border-slate-800 flex flex-col shrink-0 overflow-y-auto">
          {error && (
            <div className="m-4 p-4 bg-red-950/50 border border-red-800 rounded-xl text-sm text-red-300">
              {error}
            </div>
          )}

          {isProcessing && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
              <FaSpinner className="animate-spin text-4xl text-emerald-400" />
              <div className="text-center">
                <p className="text-lg font-semibold text-slate-300">
                  Reading the board...
                </p>
                <p className="text-sm text-slate-500 mt-1">
                  Gemini is analyzing stone positions
                </p>
              </div>
            </div>
          )}

          {!result && !isProcessing && !error && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
              <div className="text-slate-600 text-sm">
                <p className="text-lg font-semibold text-slate-500 mb-2">
                  How it works
                </p>
                <ol className="text-left space-y-2 text-slate-500">
                  <li>
                    <span className="text-emerald-500 font-bold">1.</span>{" "}
                    Upload a photo of your finished Go board
                  </li>
                  <li>
                    <span className="text-emerald-500 font-bold">2.</span>{" "}
                    Komi detects stone positions using AI vision
                  </li>
                  <li>
                    <span className="text-emerald-500 font-bold">3.</span>{" "}
                    Area scoring (Chinese rules) is calculated
                  </li>
                </ol>
              </div>

              <div className="mt-6 w-full max-w-xs">
                <label className="text-xs text-slate-500 font-semibold uppercase tracking-wider block mb-1">
                  Komi
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={komi}
                  onChange={(e) => setKomi(parseFloat(e.target.value) || 6.5)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
          )}

          {result && <ScoreDisplay result={result} onReset={handleReset} />}
        </div>
      </main>
    </div>
  );
};

// --- Score Display Sub-Component ---

function ScoreDisplay({
  result,
  onReset,
}: {
  result: ImageScoringResult;
  onReset: () => void;
}) {
  const { score, confidence, boardSize } = result;

  return (
    <div className="p-4 space-y-4">
      {/* Winner Banner */}
      <div
        className={`p-5 rounded-xl border text-center ${
          score.winner === "B"
            ? "bg-slate-800/80 border-slate-600"
            : "bg-slate-100/10 border-slate-500"
        }`}
      >
        <div className="text-xs text-slate-500 uppercase tracking-widest font-bold mb-1">
          Result
        </div>
        <div className="text-3xl font-black text-white">
          {score.winner === "B" ? "Black" : "White"} wins
        </div>
        <div className="text-xl font-bold text-emerald-400 mt-1">
          by {score.margin.toFixed(1)} points
        </div>
        <div className="text-sm text-slate-500 mt-2">
          {score.winner}+{score.margin.toFixed(1)} (Chinese Rules)
        </div>
      </div>

      {/* Score Breakdown */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-4 h-4 rounded-full bg-slate-950 border border-slate-700" />
            <span className="text-sm font-bold text-white">Black</span>
          </div>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Stones</span>
              <span className="text-slate-200 font-mono">
                {score.blackStones}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Territory</span>
              <span className="text-slate-200 font-mono">
                {score.blackTerritory}
              </span>
            </div>
            <div className="flex justify-between border-t border-slate-700 pt-1 mt-1">
              <span className="text-slate-400 font-semibold">Total</span>
              <span className="text-emerald-400 font-mono font-bold">
                {score.blackTotal}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-4 h-4 rounded-full bg-slate-200 border border-slate-400" />
            <span className="text-sm font-bold text-white">White</span>
          </div>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Stones</span>
              <span className="text-slate-200 font-mono">
                {score.whiteStones}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Territory</span>
              <span className="text-slate-200 font-mono">
                {score.whiteTerritory}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">Komi</span>
              <span className="text-slate-200 font-mono">{score.komi}</span>
            </div>
            <div className="flex justify-between border-t border-slate-700 pt-1 mt-1">
              <span className="text-slate-400 font-semibold">Total</span>
              <span className="text-emerald-400 font-mono font-bold">
                {score.whiteTotal.toFixed(1)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Meta */}
      <div className="bg-slate-950/50 rounded-xl p-3 border border-slate-800 text-xs space-y-1">
        <div className="flex justify-between">
          <span className="text-slate-500">Board Size</span>
          <span className="text-slate-300">
            {boardSize}x{boardSize}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Dame</span>
          <span className="text-slate-300">{score.dame}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">Detection Confidence</span>
          <span
            className={`font-semibold ${
              confidence === "high"
                ? "text-emerald-400"
                : confidence === "medium"
                  ? "text-yellow-400"
                  : "text-red-400"
            }`}
          >
            {confidence}
          </span>
        </div>
      </div>

      {confidence !== "high" && (
        <div className="p-3 bg-yellow-950/30 border border-yellow-800/50 rounded-xl text-xs text-yellow-300/80">
          Detection confidence is {confidence}. The AI may have misread some
          stones. Double-check the detected board on the left matches your
          actual game.
        </div>
      )}

      {/* Actions */}
      <button
        onClick={onReset}
        className="w-full py-2.5 rounded-lg text-sm font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 transition-all"
      >
        Score Another Game
      </button>
    </div>
  );
}

export default ImageScorer;
