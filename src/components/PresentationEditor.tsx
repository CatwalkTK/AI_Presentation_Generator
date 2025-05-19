import React, { useEffect, useRef, useState } from 'react';
import Reveal from 'reveal.js';
import { Maximize2, Minimize2, ImagePlus, FileDown, Save, Volume2 } from 'lucide-react';
import { openai, generateNarration, generateSpeech } from '../lib/openai';
import { imageQueue } from '../lib/imageQueue';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { escapeHtml, isSafeUrl } from '../lib/utils';
import 'reveal.js/dist/reveal.css';
import 'reveal.js/dist/theme/white.css';

interface PresentationEditorProps {
  content: string;
  title: string;
  company: string;
  creator: string;
  onSave: (content: string) => void;
  onSavePresentation?: () => void;
}

interface GeneratedImage {
  id: string;
  url: string;
  alt: string;
}

interface SlideNarration {
  slideIndex: number;
  text: string;
  isPlaying: boolean;
  audioUrl?: string; // OpenAI TTSで生成された音声のURL
}

export function PresentationEditor({ content, title, company, creator, onSave, onSavePresentation }: PresentationEditorProps) {
  const presentationRef = useRef<HTMLDivElement>(null);
  const deck = useRef<Reveal.Api | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  const [isGeneratingImages, setIsGeneratingImages] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const currentSlideRef = useRef<{ h: number; v: number; f: number | undefined }>({ h: 0, v: 0, f: undefined });
  const contentRef = useRef(content);
  const [narrations, setNarrations] = useState<SlideNarration[]>([]);
  const [isGeneratingNarration, setIsGeneratingNarration] = useState(false);
  const [isGeneratingTTS, setIsGeneratingTTS] = useState(false);
  const speechSynthesisRef = useRef<SpeechSynthesisUtterance | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const generateImages = async () => {
    if (isGeneratingImages) return;

    const slides = content
      .split(/\n\n+/)
      .filter(slide => slide.trim() !== '' && slide.trim() !== '---');

    setIsGeneratingImages(true);
    setError(null);
    setProgress({ current: 0, total: slides.length });
    
    try {
      const newImages: GeneratedImage[] = [];
      
      for (let i = 0; i < slides.length; i++) {
        const image = await imageQueue.add(slides[i]);
        if (image) {
          newImages.push(image);
        }
        setProgress(prev => ({ ...prev, current: i + 1 }));
      }

      setGeneratedImages(newImages);
    } catch (error) {
      if (error instanceof Error) {
        setError(error.message);
      }
    } finally {
      setIsGeneratingImages(false);
    }
  };

  const generateNarrations = async () => {
    if (isGeneratingNarration) return;

    const slides = content
      .split(/\n\n+/)
      .filter(slide => slide.trim() !== '' && slide.trim() !== '---');

    setIsGeneratingNarration(true);
    setError(null);
    setProgress({ current: 0, total: slides.length });
    
    try {
      const newNarrations: SlideNarration[] = [];
      
      for (let i = 0; i < slides.length; i++) {
        const narrationText = await generateNarration(slides[i]);
        
        // OpenAI TTSで音声を生成
        setIsGeneratingTTS(true);
        try {
          const audioData = await generateSpeech(narrationText);
          // ArrayBufferからBlobを作成
          const blob = new Blob([audioData], { type: 'audio/mp3' });
          // BlobからURLを作成
          const audioUrl = URL.createObjectURL(blob);
          
          newNarrations.push({
            slideIndex: i,
            text: narrationText,
            isPlaying: false,
            audioUrl: audioUrl
          });
        } catch (ttsError) {
          console.error("TTS生成エラー:", ttsError);
          newNarrations.push({
            slideIndex: i,
            text: narrationText,
            isPlaying: false
          });
        } finally {
          setIsGeneratingTTS(false);
        }
        
        setProgress(prev => ({ ...prev, current: i + 1 }));
      }

      setNarrations(newNarrations);
    } catch (error) {
      if (error instanceof Error) {
        setError(error.message);
      }
    } finally {
      setIsGeneratingNarration(false);
    }
  };

  const playNarration = (slideIndex: number) => {
    // 再生中の音声があれば停止
    stopNarration();

    const narration = narrations.find(n => n.slideIndex === slideIndex);
    if (!narration) return;

    // ナレーションの状態を更新
    setNarrations(prev => 
      prev.map(n => ({
        ...n,
        isPlaying: n.slideIndex === slideIndex
      }))
    );

    // OpenAI TTSで生成された音声があればそれを使用
    if (narration.audioUrl) {
      if (!audioRef.current) {
        audioRef.current = new Audio();
      }
      
      const audio = audioRef.current;
      audio.src = narration.audioUrl;
      audio.onended = () => {
        setNarrations(prev => 
          prev.map(n => ({
            ...n,
            isPlaying: false
          }))
        );
      };
      
      audio.onerror = () => {
        console.error('音声再生エラー:', audio.error);
        setNarrations(prev => 
          prev.map(n => ({
            ...n,
            isPlaying: false
          }))
        );
        
        // フォールバック: ブラウザのSpeech Synthesis APIを使用
        useBrowserSpeechSynthesis(narration.text);
      };
      
      audio.play().catch(error => {
        console.error('音声再生エラー:', error);
        // フォールバック: ブラウザのSpeech Synthesis APIを使用
        useBrowserSpeechSynthesis(narration.text);
      });
    } else {
      // OpenAI TTSで生成された音声がない場合はブラウザのSpeech Synthesis APIを使用
      useBrowserSpeechSynthesis(narration.text);
    }
  };

  // ブラウザのSpeech Synthesis APIを使用
  const useBrowserSpeechSynthesis = (text: string) => {
    if (speechSynthesisRef.current) {
      window.speechSynthesis.cancel();
    }

    // Speech Synthesis の設定
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ja-JP';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // 終了時の処理
    utterance.onend = () => {
      setNarrations(prev => 
        prev.map(n => ({
          ...n,
          isPlaying: false
        }))
      );
      speechSynthesisRef.current = null;
    };

    // エラー時の処理
    utterance.onerror = () => {
      setNarrations(prev => 
        prev.map(n => ({
          ...n,
          isPlaying: false
        }))
      );
      speechSynthesisRef.current = null;
    };

    // 再生
    speechSynthesisRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  };

  const stopNarration = () => {
    // Speech Synthesis APIを停止
    if (speechSynthesisRef.current) {
      window.speechSynthesis.cancel();
      speechSynthesisRef.current = null;
    }
    
    // Audio要素を停止
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    
    // 再生状態をリセット
    setNarrations(prev => 
      prev.map(n => ({
        ...n,
        isPlaying: false
      }))
    );
  };

  const exportToPDF = async () => {
    if (!presentationRef.current || !deck.current || isExporting) return;
    
    setIsExporting(true);
    setError(null);

    try {
      // Save current slide
      const currentIndices = deck.current.getIndices();
      
      // Get all slides
      const slides = Array.from(presentationRef.current.querySelectorAll('section'));
      const totalSlides = slides.length;
      
      // PDFのファイル名を作成（安全な文字のみ使用）
      const safePdfName = `presentation-${new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '-')}.pdf`;
      
      // Create PDF with landscape orientation
      const pdf = new jsPDF({
        orientation: 'landscape',
        unit: 'px',
        format: [1920, 1080]
      });

      // Process each slide
      for (let i = 0; i < totalSlides; i++) {
        // Go to the slide
        deck.current.slide(i, 0);
        await new Promise(resolve => setTimeout(resolve, 500));
        
        const slideElement = slides[i];
        
        // Create a temporary container
        const container = document.createElement('div');
        container.style.width = '1920px';
        container.style.height = '1080px';
        container.style.position = 'fixed';
        container.style.left = '-9999px';
        container.style.top = '0';
        container.style.backgroundColor = 'white';
        container.style.overflow = 'hidden';
        
        // Clone and style the slide
        const slideClone = slideElement.cloneNode(true) as HTMLElement;
        slideClone.style.visibility = 'visible';
        slideClone.style.display = 'block';
        slideClone.style.transform = 'none';
        slideClone.style.width = '100%';
        slideClone.style.height = '100%';
        
        // XSS対策：スクリプトタグや危険な要素を削除
        const scriptElements = slideClone.querySelectorAll('script, iframe, object, embed');
        scriptElements.forEach(element => element.remove());
        
        // イベントハンドラ属性を削除
        const allElements = slideClone.querySelectorAll('*');
        allElements.forEach(element => {
          // onclick, onerror などのイベントハンドラを削除
          const attributes = Array.from(element.attributes);
          attributes.forEach(attr => {
            if (attr.name.startsWith('on') || attr.value.includes('javascript:')) {
              element.removeAttribute(attr.name);
            }
          });
        });
        
        container.appendChild(slideClone);
        
        // Add to document temporarily
        document.body.appendChild(container);
        
        try {
          // Convert to canvas
          const canvas = await html2canvas(container, {
            width: 1920,
            height: 1080,
            scale: 2,
            useCORS: true,
            allowTaint: true,
            backgroundColor: 'white',
            logging: false
          });
          
          // Add to PDF
          const imgData = canvas.toDataURL('image/jpeg', 1.0);
          if (i > 0) {
            pdf.addPage([1920, 1080], 'landscape');
          }
          pdf.addImage(imgData, 'JPEG', 0, 0, 1920, 1080);
          
        } finally {
          // Clean up
          document.body.removeChild(container);
        }
      }
      
      // Save the PDF
      pdf.save(safePdfName);
      
      // Restore original slide
      deck.current.slide(currentIndices.h, currentIndices.v, currentIndices.f);
    } catch (error) {
      console.error('Error exporting to PDF:', error);
      setError('PDFの生成に失敗しました。もう一度お試しください。');
    } finally {
      setIsExporting(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    let timeoutId: number;

    const initializeReveal = async () => {
      if (!presentationRef.current || !mounted) return;

      try {
        if (deck.current) {
          const indices = deck.current.getIndices();
          currentSlideRef.current = {
            h: indices.h,
            v: indices.v,
            f: indices.f
          };
          deck.current.destroy();
          deck.current = null;
        }

        const newDeck = new Reveal(presentationRef.current, {
          embedded: true,
          hash: false,
          width: 960,
          height: 700,
          margin: 0.04,
          controls: true,
          progress: true,
          center: true,
          transition: 'none',
          showNotes: false,
        });

        await newDeck.initialize();
        
        if (mounted) {
          deck.current = newDeck;

          newDeck.on('slidechanged', () => {
            if (deck.current) {
              const indices = deck.current.getIndices();
              currentSlideRef.current = {
                h: indices.h,
                v: indices.v,
                f: indices.f
              };
            }
          });

          if (currentSlideRef.current && contentRef.current !== content) {
            timeoutId = window.setTimeout(() => {
              if (deck.current && mounted) {
                deck.current.slide(
                  currentSlideRef.current.h,
                  currentSlideRef.current.v,
                  currentSlideRef.current.f
                );
              }
            }, 100);
          }
          
          contentRef.current = content;
        } else {
          try {
            newDeck.destroy();
          } catch (e) {
            console.warn('Error during Reveal cleanup after unmount:', e);
          }
        }
      } catch (error) {
        console.error('Error initializing Reveal:', error);
      }
    };

    requestAnimationFrame(() => {
      if (mounted) {
        initializeReveal();
      }
    });

    return () => {
      mounted = false;
      window.clearTimeout(timeoutId);
      if (deck.current) {
        try {
          deck.current.destroy();
        } catch (e) {
          console.warn('Error during Reveal cleanup on unmount:', e);
        }
        deck.current = null;
      }
    };
  }, [content]);

  const getRandomPosition = () => {
    const positions = [
      'top-0 left-0',
      'top-0 right-0',
      'bottom-0 left-0',
      'bottom-0 right-0',
      'top-1/2 -translate-y-1/2 left-0',
      'top-1/2 -translate-y-1/2 right-0',
    ];
    return positions[Math.floor(Math.random() * positions.length)];
  };

  const processSlideContent = (slideText: string, index: number) => {
    const lines = slideText.trim().split('\n');
    let html = '';
    let inList = false;
    let isFirstSlide = index === 0;
    
    const image = generatedImages[index];
    const imagePosition = getRandomPosition();
    
    if (image && isSafeUrl(image.url)) {
      const safeUrl = escapeHtml(image.url);
      const safeAlt = escapeHtml(image.alt);
      html += `<div class="absolute ${imagePosition} p-4 opacity-20 pointer-events-none">
        <img src="${safeUrl}" alt="${safeAlt}" class="max-w-[300px] max-h-[300px] object-contain rounded-lg" />
      </div>`;
    }
    
    html += '<div class="relative z-10">';
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine === '---') continue;
      
      const imageMatch = trimmedLine.match(/!\[(.*?)\]\((.*?)\)/);
      if (imageMatch) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        const [, alt, url] = imageMatch;
        if (isSafeUrl(url)) {
          const safeUrl = escapeHtml(url);
          const safeAlt = escapeHtml(alt);
          html += `<div class="flex justify-center my-4">
            <img src="${safeUrl}" alt="${safeAlt}" class="max-h-[500px] max-w-full object-contain rounded-lg shadow-lg" />
          </div>`;
        } else {
          html += `<div class="flex justify-center my-4 p-4 bg-red-50 border border-red-200 rounded-md text-red-600">
            不安全なURLが検出されました
          </div>`;
        }
        continue;
      }
      
      if (trimmedLine.startsWith('# ')) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        const safeText = escapeHtml(trimmedLine.substring(2));
        if (isFirstSlide) {
          html += `<h1 class="text-4xl font-bold mb-24">${safeText}</h1>`;
        } else {
          html += `<h1 class="text-4xl font-bold mb-8">${safeText}</h1>`;
        }
      } else if (trimmedLine.startsWith('## ')) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        const safeText = escapeHtml(trimmedLine.substring(3));
        html += `<h2 class="text-2xl font-semibold mb-6 text-right">${safeText}</h2>`;
      } else if (trimmedLine.startsWith('- ')) {
        if (!inList) {
          html += '<ul class="list-disc list-inside space-y-4">';
          inList = true;
        }
        const safeText = escapeHtml(trimmedLine.substring(2));
        html += `<li class="text-xl">${safeText}</li>`;
      } else if (trimmedLine !== '') {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        const safeText = escapeHtml(trimmedLine);
        html += `<p class="text-xl mb-4">${safeText}</p>`;
      }
    }

    if (inList) {
      html += '</ul>';
    }

    html += '</div>';
    return html;
  };

  const slides = content
    .split(/\n\n+/)
    .filter(slide => slide.trim() !== '' && slide.trim() !== '---')
    .map((slide, index) => processSlideContent(slide.trim(), index));

  const toggleFullscreen = async () => {
    try {
      if (!isFullscreen) {
        const element = presentationRef.current?.closest('.presentation-container');
        if (element) {
          if (deck.current) {
            deck.current.toggleOverview(false);
          }
          await element.requestFullscreen();
          setIsFullscreen(true);
        }
      } else {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
        setIsFullscreen(false);
      }
    } catch (error) {
      console.error('Error toggling fullscreen:', error);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement !== null);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);
  
  // Reveal.jsでスライドが変わったときにナレーションを自動再生する
  useEffect(() => {
    if (!deck.current) return;
    
    const handleSlideChange = () => {
      if (!deck.current) return;
      
      const currentIndices = deck.current.getIndices();
      const currentSlideIndex = currentIndices.h;
      
      // ナレーションが生成されていて、現在のスライドがあれば再生
      const narration = narrations.find(n => n.slideIndex === currentSlideIndex);
      if (narration) {
        playNarration(currentSlideIndex);
      }
    };
    
    deck.current.on('slidechanged', handleSlideChange);
    
    return () => {
      if (deck.current) {
        // @ts-ignore - TypeScriptの型定義にoffが含まれていないがReveal.jsにはある
        deck.current.off('slidechanged', handleSlideChange);
      }
    };
  }, [narrations]);

  return (
    <div className="w-full bg-white rounded-xl shadow-lg overflow-hidden relative">
      <div className="flex">
        <div className="presentation-container w-3/4 border-r border-gray-200 relative min-h-[700px]">
          {isGeneratingImages && (
            <div className="absolute inset-0 bg-white/80 z-50 flex items-center justify-center">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
                <p className="text-gray-600">画像を生成中... ({progress.current}/{progress.total})</p>
                {error && (
                  <p className="text-red-600 mt-2 text-sm">{error}</p>
                )}
              </div>
            </div>
          )}
          {(isGeneratingNarration || isGeneratingTTS) && (
            <div className="absolute inset-0 bg-white/80 z-50 flex items-center justify-center">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
                <p className="text-gray-600">
                  {isGeneratingTTS 
                    ? "音声を生成中..."
                    : `ナレーションを生成中... (${progress.current}/${progress.total})`
                  }
                </p>
                {error && (
                  <p className="text-red-600 mt-2 text-sm">{error}</p>
                )}
              </div>
            </div>
          )}
          {isExporting && (
            <div className="absolute inset-0 bg-white/80 z-50 flex items-center justify-center">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
                <p className="text-gray-600">PDFを生成中...</p>
                {error && (
                  <p className="text-red-600 mt-2 text-sm">{error}</p>
                )}
              </div>
            </div>
          )}
          <div className="absolute top-4 right-4 z-50 flex gap-2">
            <button
              onClick={exportToPDF}
              disabled={isExporting}
              className="p-3 bg-blue-600 hover:bg-blue-700 rounded-full shadow-lg transition-colors disabled:bg-blue-400 disabled:cursor-not-allowed"
              title="PDFとして保存"
            >
              <FileDown className="w-6 h-6 text-white" />
            </button>
            <button
              onClick={generateImages}
              disabled={isGeneratingImages}
              className="p-3 bg-blue-600 hover:bg-blue-700 rounded-full shadow-lg transition-colors disabled:bg-blue-400 disabled:cursor-not-allowed"
              title="AIで画像を生成"
            >
              <ImagePlus className="w-6 h-6 text-white" />
            </button>
            <button
              onClick={generateNarrations}
              disabled={isGeneratingNarration || isGeneratingTTS}
              className="p-3 bg-blue-600 hover:bg-blue-700 rounded-full shadow-lg transition-colors disabled:bg-blue-400 disabled:cursor-not-allowed"
              title="GPT-4o mini + TTSでナレーションを生成"
            >
              <Volume2 className="w-6 h-6 text-white" />
            </button>
            <button
              onClick={toggleFullscreen}
              className="p-3 bg-blue-600 hover:bg-blue-700 rounded-full shadow-lg transition-colors"
              title={isFullscreen ? "全画面表示を終了" : "全画面表示に切り替え"}
            >
              {isFullscreen ? (
                <Minimize2 className="w-6 h-6 text-white" />
              ) : (
                <Maximize2 className="w-6 h-6 text-white" />
              )}
            </button>
            {onSavePresentation && (
              <button
                onClick={onSavePresentation}
                className="p-3 bg-green-600 hover:bg-green-700 rounded-full shadow-lg transition-colors"
                title="プレゼンテーションを保存"
              >
                <Save className="w-6 h-6 text-white" />
              </button>
            )}
          </div>
          <div className="reveal" ref={presentationRef}>
            <div className="slides">
              {slides.map((slideContent, index) => (
                <section 
                  key={index}
                  className="p-8"
                  data-notes={narrations.find(n => n.slideIndex === index)?.text}
                >
                  <div 
                    dangerouslySetInnerHTML={{ __html: slideContent }}
                    className="max-w-4xl mx-auto relative"
                  />
                </section>
              ))}
            </div>
          </div>
        </div>
        <div className="w-1/4 p-4">
          <h3 className="text-lg font-semibold mb-4">スライドの編集</h3>
          <div className="mb-4 text-sm text-gray-600">
            <p>フォーマットガイド:</p>
            <ul className="list-disc list-inside">
              <li># タイトル</li>
              <li>## サブタイトル</li>
              <li>- 箇条書き</li>
              <li>![代替テキスト](画像URL)</li>
              <li>空行で新しいスライド</li>
            </ul>
          </div>
          {narrations.length > 0 && (
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
              <h4 className="font-semibold text-blue-800 mb-2">スピーカーノート</h4>
              {deck.current && (
                <div className="text-sm text-gray-700">
                  <p className="italic mb-2">{narrations.find(n => n.slideIndex === deck.current?.getIndices().h)?.text || "現在のスライドのナレーションがありません"}</p>
                  <div className="flex justify-end mt-2">
                    <button 
                      onClick={() => playNarration(deck.current?.getIndices().h || 0)}
                      className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1"
                    >
                      <Volume2 className="w-3 h-3" />
                      {narrations.find(n => n.slideIndex === deck.current?.getIndices().h)?.audioUrl 
                        ? "AI音声で再生" 
                        : "再生"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          <textarea
            className="w-full h-[500px] p-4 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
            value={content}
            onChange={(e) => onSave(e.target.value)}
            placeholder="プレゼンテーションの内容を入力してください..."
          />
        </div>
      </div>
    </div>
  );
}