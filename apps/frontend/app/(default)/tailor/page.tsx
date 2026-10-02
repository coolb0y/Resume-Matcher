'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useResumePreview } from '@/components/common/resume_previewer_context';
import type { ImprovedResult } from '@/components/common/resume_previewer_context';
import type { ResumeData } from '@/components/dashboard/resume-component';
import {
  uploadJobDescriptions,
  previewImproveResume,
  confirmImproveResume,
  addJobToQueue,
  fetchJobQueue,
  deleteQueueItem,
  clearQueueItems,
  type QueueItem,
} from '@/lib/api/resume';
import { fetchPromptConfig, type PromptOption } from '@/lib/api/config';
import { Dropdown } from '@/components/ui/dropdown';
import { RetroTabs } from '@/components/ui/retro-tabs';
import { useStatusCache } from '@/lib/context/status-cache';
import {
  Loader2,
  ArrowLeft,
  AlertTriangle,
  Settings,
  CheckCircle2,
  Clock,
  ExternalLink,
  RefreshCw,
  Plus,
  Trash2,
  Briefcase,
  Building2,
  Hash,
  Sparkles,
} from 'lucide-react';
import { useTranslations } from '@/lib/i18n';
import { DiffPreviewModal } from '@/components/tailor/diff-preview-modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export default function TailorPage() {
  const { t } = useTranslations();
  const [jobDescription, setJobDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [masterResumeId, setMasterResumeId] = useState<string | null>(null);
  const [promptOptions, setPromptOptions] = useState<PromptOption[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState('keywords');
  const [promptLoading, setPromptLoading] = useState(false);
  const hasUserSelectedPrompt = useRef(false);
  const missingDiffConfirmInFlight = useRef(false);

  // Mode selection: 'single' or 'queue'
  const [activeTab, setActiveTab] = useState<'single' | 'queue'>('single');

  // Tailoring Queue state
  const [queueInput, setQueueInput] = useState('');
  const [queueRole, setQueueRole] = useState('');
  const [queueCompany, setQueueCompany] = useState('');
  const [queueJobReqId, setQueueJobReqId] = useState('');
  const [rateLimitSeconds, setRateLimitSeconds] = useState(5);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [isAddingToQueue, setIsAddingToQueue] = useState(false);
  const [isRefreshingQueue, setIsRefreshingQueue] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueSuccessMessage, setQueueSuccessMessage] = useState<string | null>(null);

  // Diff preview modal state
  const [showDiffModal, setShowDiffModal] = useState(false);
  const [pendingResult, setPendingResult] = useState<ImprovedResult | null>(null);
  const [diffConfirmError, setDiffConfirmError] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [showRegenerateDialog, setShowRegenerateDialog] = useState(false);
  const [showMissingDiffDialog, setShowMissingDiffDialog] = useState(false);
  const [missingDiffResult, setMissingDiffResult] = useState<ImprovedResult | null>(null);
  const [missingDiffError, setMissingDiffError] = useState<string | null>(null);

  // Elapsed timer for long operations
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setElapsed(0);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const router = useRouter();
  const { setImprovedData } = useResumePreview();
  const {
    status: systemStatus,
    isLoading: statusLoading,
    incrementJobs,
    incrementImprovements,
    incrementResumes,
  } = useStatusCache();

  // Check if LLM is configured
  const isLlmConfigured = !statusLoading && systemStatus?.llm_configured;

  useEffect(() => {
    const storedId = localStorage.getItem('master_resume_id');
    if (!storedId) {
      router.push('/dashboard');
    } else {
      setMasterResumeId(storedId);
    }
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    const loadPromptConfig = async () => {
      setPromptLoading(true);
      try {
        const config = await fetchPromptConfig();
        if (!cancelled) {
          setPromptOptions(config.prompt_options || []);
          if (!hasUserSelectedPrompt.current) {
            setSelectedPromptId(config.default_prompt_id || 'keywords');
          }
        }
      } catch (err) {
        console.error('Failed to load prompt config', err);
      } finally {
        if (!cancelled) {
          setPromptLoading(false);
        }
      }
    };

    loadPromptConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  // Heuristic metadata parser for instant zero-LLM metadata extraction
  const parseMetadataLocal = (text: string) => {
    let role = '';
    let company = '';
    let jobReqId = '';
    if (!text || !text.trim()) return { role, company, jobReqId };

    const lines = text
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of lines.slice(0, 25)) {
      if (!role) {
        const mRole = line.match(/^(?:job\s+title|role|position|title)\s*[:\-]\s*(.+)$/i);
        if (mRole) role = mRole[1].trim();
      }
      if (!company) {
        const mComp = line.match(/^(?:company|organization|employer|client)\s*[:\-]\s*(.+)$/i);
        if (mComp) company = mComp[1].trim();
      }
      if (!jobReqId) {
        const mId = line.match(
          /(?:job\s*id|req(?:uisition)?\s*id|req\s*#|job\s*#|requisition)\s*[:\-#]?\s*([a-zA-Z0-9_\-]+)/i
        );
        if (mId) jobReqId = mId[1].trim();
      }
    }

    if (!role && lines.length > 0) {
      const firstLine = lines[0];
      const mAt = firstLine.match(/^(.+?)\s+(?:at|@)\s+([A-Za-z0-9&.\s]{2,40})$/i);
      if (mAt) {
        role = mAt[1].trim();
        if (!company) company = mAt[2].trim();
      } else if (
        firstLine.length < 70 &&
        !/about us|overview|description|welcome/i.test(firstLine)
      ) {
        role = firstLine;
      }
    }

    if (!company) {
      for (const line of lines.slice(0, 20)) {
        const mAbout = line.match(/^about\s+([A-Z][A-Za-z0-9&.\s]{2,35})\b/i);
        if (mAbout) {
          company = mAbout[1].trim();
          break;
        }
        const mHiring = line.match(/^([A-Z][A-Za-z0-9&.\s]{2,35})\s+is\s+(?:looking|hiring|seeking)/i);
        if (mHiring) {
          company = mHiring[1].trim();
          break;
        }
      }
    }

    return {
      role: role.slice(0, 70).trim(),
      company: company.slice(0, 60).trim(),
      jobReqId: jobReqId.slice(0, 35).trim(),
    };
  };

  const handleQueueInputChange = (text: string) => {
    setQueueInput(text);
    const parsed = parseMetadataLocal(text);
    if (parsed.role) setQueueRole(parsed.role);
    if (parsed.company) setQueueCompany(parsed.company);
    if (parsed.jobReqId) setQueueJobReqId(parsed.jobReqId);
  };

  // Fetch queue items
  const loadQueue = useCallback(async () => {
    if (!masterResumeId) return;
    try {
      const items = await fetchJobQueue(masterResumeId);
      setQueueItems(items);
    } catch (err) {
      console.error('Failed to load queue', err);
    }
  }, [masterResumeId]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // Poll queue progress when there are pending or processing items
  useEffect(() => {
    if (!masterResumeId) return;
    const hasActiveItems = queueItems.some(
      (item) => item.status === 'pending' || item.status === 'processing'
    );
    if (!hasActiveItems) return;

    const interval = setInterval(async () => {
      try {
        const items = await fetchJobQueue(masterResumeId);
        setQueueItems(items);
      } catch (err) {
        console.error('Failed to poll queue', err);
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [masterResumeId, queueItems]);

  const handleAddToQueue = async () => {
    if (!masterResumeId) {
      setQueueError('Master resume not found. Please upload a master resume first.');
      return;
    }
    const trimmed = queueInput.trim();
    if (!trimmed) {
      setQueueError('Please enter a job description.');
      return;
    }
    if (trimmed.length < 20) {
      setQueueError('Job description is too short.');
      return;
    }

    setIsAddingToQueue(true);
    setQueueError(null);
    setQueueSuccessMessage(null);

    try {
      const newItem = await addJobToQueue(
        masterResumeId,
        trimmed,
        rateLimitSeconds,
        queueRole.trim() || undefined,
        queueCompany.trim() || undefined,
        queueJobReqId.trim() || undefined,
        selectedPromptId
      );

      setQueueItems((prev) => [newItem, ...prev.filter((i) => i.item_id !== newItem.item_id)]);
      setQueueInput('');
      setQueueRole('');
      setQueueCompany('');
      setQueueJobReqId('');
      setQueueSuccessMessage('Added to queue! You can now paste your next job description.');
      setTimeout(() => setQueueSuccessMessage(null), 4500);
      incrementJobs();
    } catch (err) {
      console.error('Failed to add job to queue', err);
      setQueueError(err instanceof Error ? err.message : 'Failed to add job to queue');
    } finally {
      setIsAddingToQueue(false);
    }
  };

  const handleDeleteQueueItem = async (itemId: string) => {
    try {
      await deleteQueueItem(itemId);
      setQueueItems((prev) => prev.filter((i) => i.item_id !== itemId));
    } catch (err) {
      console.error('Failed to delete queue item', err);
    }
  };

  const handleClearCompleted = async () => {
    try {
      await clearQueueItems('completed');
      setQueueItems((prev) => prev.filter((i) => i.status !== 'completed'));
    } catch (err) {
      console.error('Failed to clear completed items', err);
    }
  };

  const handleRefreshQueue = async () => {
    if (!masterResumeId) return;
    setIsRefreshingQueue(true);
    try {
      const items = await fetchJobQueue(masterResumeId);
      setQueueItems(items);
    } catch (err) {
      console.error('Failed to refresh queue', err);
    } finally {
      setIsRefreshingQueue(false);
    }
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') e.stopPropagation();
  };

  const buildConfirmPayload = (result: ImprovedResult) => {
    if (!masterResumeId) {
      throw new Error('Master resume ID is missing.');
    }
    const resumePreview = result.data.resume_preview;
    if (!resumePreview || typeof resumePreview !== 'object' || Array.isArray(resumePreview)) {
      throw new Error('Resume preview data is invalid.');
    }
    const previewRecord = resumePreview as unknown as Record<string, unknown>;
    if (
      !previewRecord.personalInfo ||
      typeof previewRecord.personalInfo !== 'object' ||
      Array.isArray(previewRecord.personalInfo)
    ) {
      throw new Error('Resume preview data is invalid.');
    }
    return {
      resume_id: masterResumeId,
      job_id: result.data.job_id,
      improved_data: resumePreview as ResumeData,
      improvements:
        result.data.improvements?.map((item) => ({
          suggestion: item.suggestion,
          lineNumber: typeof item.lineNumber === 'number' ? item.lineNumber : null,
        })) ?? [],
    };
  };

  const confirmAndNavigate = async (result: ImprovedResult) => {
    const confirmed = await confirmImproveResume(buildConfirmPayload(result));
    incrementImprovements();
    incrementResumes();
    setImprovedData(confirmed);

    const newResumeId = confirmed?.data?.resume_id;
    if (newResumeId) {
      router.push(`/resumes/${newResumeId}`);
    } else {
      router.push('/builder');
    }
  };

  const getGenerateValidationError = (trimmedDescription: string) => {
    if (!trimmedDescription) return null;
    if (trimmedDescription.length < 50) {
      return t('tailor.errors.jobDescriptionTooShort');
    }
    return null;
  };

  const runGenerate = async (resumeId: string, description: string) => {
    try {
      // 1. Upload Job Description
      // The API expects an array of strings
      const jobId = await uploadJobDescriptions([description], resumeId);
      incrementJobs(); // Update cached counter

      // 2. Preview Resume
      const result = await previewImproveResume(resumeId, jobId, selectedPromptId);

      if (!result?.data?.diff_summary || !result?.data?.detailed_changes) {
        console.warn('Diff data missing for tailor preview; requesting user confirmation.');
        setDiffConfirmError(null);
        setPendingResult(null);
        setShowDiffModal(false);
        setMissingDiffError(null);
        setMissingDiffResult(result);
        setShowMissingDiffDialog(true);
        return;
      }

      // 3. Show diff preview modal
      setDiffConfirmError(null);
      setMissingDiffError(null);
      setPendingResult(result);
      setShowDiffModal(true);
    } catch (err) {
      console.error(err);
      // Check for common error patterns
      const errorMessage = err instanceof Error ? err.message : '';
      if (
        errorMessage.toLowerCase().includes('api key') ||
        errorMessage.toLowerCase().includes('unauthorized') ||
        errorMessage.toLowerCase().includes('authentication') ||
        errorMessage.includes('401')
      ) {
        setError(t('tailor.errors.apiKeyError'));
      } else if (
        errorMessage.toLowerCase().includes('rate limit') ||
        errorMessage.includes('429')
      ) {
        setError(t('tailor.errors.rateLimit'));
      } else {
        setError(t('tailor.errors.failedToPreview'));
      }
    }
  };

  const handleGenerate = async () => {
    const trimmedDescription = jobDescription.trim();
    if (!trimmedDescription || !masterResumeId) return;
    const validationError = getGenerateValidationError(trimmedDescription);
    if (validationError) {
      setError(validationError);
      return;
    }
    const resumeId = masterResumeId;
    setIsLoading(true);
    setError(null);
    startTimer();
    try {
      await runGenerate(resumeId, trimmedDescription);
    } finally {
      setIsLoading(false);
      stopTimer();
    }
  };

  // User confirms changes
  const handleConfirmChanges = async () => {
    if (!pendingResult || isConfirming) return;

    setIsConfirming(true);
    setError(null);
    setDiffConfirmError(null);

    try {
      await confirmAndNavigate(pendingResult);
      setShowDiffModal(false);
      setPendingResult(null);
    } catch (err) {
      console.error(err);
      const errorMessage = t('tailor.errors.failedToConfirm');
      setError(errorMessage);
      setDiffConfirmError(errorMessage);
    } finally {
      setIsConfirming(false);
    }
  };

  // User rejects changes
  const handleRejectChanges = () => {
    setShowDiffModal(false);
    setPendingResult(null);
    setDiffConfirmError(null);
    setShowRegenerateDialog(true);
  };

  const handleCloseDiffModal = () => {
    setShowDiffModal(false);
    setPendingResult(null);
    setDiffConfirmError(null);
  };

  const handleCloseMissingDiffDialog = () => {
    setShowMissingDiffDialog(false);
    setMissingDiffResult(null);
    setMissingDiffError(null);
    missingDiffConfirmInFlight.current = false;
  };

  const handleMissingDiffConfirm = async () => {
    if (!missingDiffResult || isLoading || missingDiffConfirmInFlight.current) return;
    missingDiffConfirmInFlight.current = true;
    setIsLoading(true);
    setError(null);
    setMissingDiffError(null);
    try {
      await confirmAndNavigate(missingDiffResult);
      handleCloseMissingDiffDialog();
    } catch (err) {
      console.error(err);
      const errorMessage = t('tailor.errors.failedToConfirm');
      setError(errorMessage);
      setMissingDiffError(errorMessage);
    } finally {
      missingDiffConfirmInFlight.current = false;
      setIsLoading(false);
    }
  };

  const handleRegenerateConfirm = async () => {
    setShowRegenerateDialog(false);
    const trimmedDescription = jobDescription.trim();
    if (!trimmedDescription || !masterResumeId) return;
    const validationError = getGenerateValidationError(trimmedDescription);
    if (validationError) {
      setError(validationError);
      return;
    }
    const resumeId = masterResumeId;
    setIsLoading(true);
    setError(null);
    startTimer();
    try {
      await runGenerate(resumeId, trimmedDescription);
    } finally {
      setIsLoading(false);
      stopTimer();
    }
  };

  return (
    <div
      className="min-h-screen w-full bg-[#F6F5EE] flex flex-col items-center justify-center p-4 md:p-8 font-sans"
      style={{
        backgroundImage:
          'linear-gradient(rgba(29, 78, 216, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(29, 78, 216, 0.1) 1px, transparent 1px)',
        backgroundSize: '40px 40px',
      }}
    >
      <div className="w-full max-w-4xl bg-white border border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,0.1)] p-8 md:p-12 lg:p-14 relative">
        {/* Back Button */}
        <Button variant="link" className="absolute top-4 left-4" onClick={() => router.back()}>
          <ArrowLeft className="w-4 h-4" />
          {t('common.back')}
        </Button>

        <div className="mb-6 mt-4 text-center">
          <h1 className="font-serif text-4xl font-bold uppercase tracking-tight mb-2">
            {t('tailor.heroTitle')}
          </h1>
          <p className="font-mono text-sm text-blue-700 font-bold uppercase">
            {'// '}
            {activeTab === 'single'
              ? t('tailor.pasteJobDescriptionBelow')
              : 'Sequential Queue: Rate-Limited Background Tailoring'}
          </p>
        </div>

        {/* Tab switch between Single Job and Tailoring Queue */}
        <div className="mb-6 flex justify-center">
          <RetroTabs
            tabs={[
              { id: 'single', label: 'Single Job (Interactive)' },
              {
                id: 'queue',
                label:
                  queueItems.filter((i) => i.status === 'pending' || i.status === 'processing')
                    .length > 0
                    ? `Tailoring Queue (${
                        queueItems.filter(
                          (i) => i.status === 'pending' || i.status === 'processing'
                        ).length
                      } active)`
                    : `Tailoring Queue (${queueItems.length})`,
              },
            ]}
            activeTab={activeTab}
            onTabChange={(tabId) => setActiveTab(tabId as 'single' | 'queue')}
          />
        </div>

        {/* LLM Not Configured Warning */}
        {!statusLoading && !isLlmConfigured && (
          <div className="mb-6 border-2 border-amber-500 bg-amber-50 p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.1)]">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-mono text-sm font-bold uppercase tracking-wider text-amber-800">
                  {t('tailor.setupRequiredTitle')}
                </p>
                <p className="font-mono text-xs text-amber-700 mt-1">
                  {t('tailor.noApiKeyMessage')}
                </p>
                <Link
                  href="/settings"
                  className="inline-flex items-center gap-2 mt-3 text-amber-700 hover:text-amber-900 transition-colors"
                >
                  <Settings className="w-4 h-4" />
                  <span className="font-mono text-xs font-bold uppercase underline">
                    {t('tailor.configureApiKey')}
                  </span>
                </Link>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'single' ? (
          <div className="space-y-6">
            <Dropdown
              options={
                promptOptions.length > 0
                  ? promptOptions.map((opt) => ({
                      id: opt.id,
                      label: t(`tailor.promptOptions.${opt.id}.label`),
                      description: t(`tailor.promptOptions.${opt.id}.description`),
                    }))
                  : [
                      {
                        id: 'nudge',
                        label: t('tailor.promptOptions.nudge.label'),
                        description: t('tailor.promptOptions.nudge.description'),
                      },
                      {
                        id: 'keywords',
                        label: t('tailor.promptOptions.keywords.label'),
                        description: t('tailor.promptOptions.keywords.description'),
                      },
                      {
                        id: 'full',
                        label: t('tailor.promptOptions.full.label'),
                        description: t('tailor.promptOptions.full.description'),
                      },
                    ]
              }
              value={selectedPromptId}
              onChange={(value) => {
                hasUserSelectedPrompt.current = true;
                setSelectedPromptId(value);
              }}
              label={t('tailor.promptLabel')}
              description={t('tailor.promptDescription')}
              disabled={isLoading || promptLoading}
            />

            <div className="relative">
              <Textarea
                placeholder={t('tailor.jobDescriptionPlaceholder')}
                className="min-h-[300px] font-mono text-sm bg-[#F0F0E8] border-2 border-black focus:ring-0 focus:border-blue-700 resize-none p-4 rounded-none"
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                onKeyDown={handleTextareaKeyDown}
                disabled={isLoading}
              />
              <div className="absolute bottom-2 right-2 text-xs font-mono text-gray-400 pointer-events-none">
                {t('tailor.charactersCount', { count: jobDescription.length })}
              </div>
            </div>

            {error && (
              <div className="p-4 bg-red-50 border border-red-200 text-red-700 text-sm font-mono flex items-center gap-2">
                <span>!</span> {error}
              </div>
            )}

            <Button
              size="lg"
              onClick={handleGenerate}
              disabled={isLoading || statusLoading || !jobDescription.trim() || !isLlmConfigured}
              className="w-full"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {t('common.processing')}
                  {elapsed > 0 && (
                    <span className="font-mono text-xs opacity-70 ml-2">{elapsed}s</span>
                  )}
                </>
              ) : statusLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {t('common.checking')}
                </>
              ) : !isLlmConfigured ? (
                t('tailor.configureApiKeyFirst')
              ) : (
                t('tailor.generateTailored')
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Queue Explainer Box */}
            <div className="bg-[#F0F0E8] border-2 border-black p-4">
              <p className="font-mono text-xs font-bold uppercase text-black mb-1">
                {'// How the Tailoring Queue Works:'}
              </p>
              <p className="font-mono text-xs text-gray-700 leading-relaxed">
                Paste a job description below and click <strong>Add to Tailoring Queue</strong>. We
                automatically detect the role, company, and job ID so you can track each
                application. Add as many jobs as you like one by one; they will be generated
                sequentially in the background with your configured cooldown delay to prevent LLM
                rate limits.
              </p>
            </div>

            {/* Prompt strategy dropdown */}
            <Dropdown
              options={
                promptOptions.length > 0
                  ? promptOptions.map((opt) => ({
                      id: opt.id,
                      label: t(`tailor.promptOptions.${opt.id}.label`),
                      description: t(`tailor.promptOptions.${opt.id}.description`),
                    }))
                  : [
                      {
                        id: 'nudge',
                        label: t('tailor.promptOptions.nudge.label'),
                        description: t('tailor.promptOptions.nudge.description'),
                      },
                      {
                        id: 'keywords',
                        label: t('tailor.promptOptions.keywords.label'),
                        description: t('tailor.promptOptions.keywords.description'),
                      },
                      {
                        id: 'full',
                        label: t('tailor.promptOptions.full.label'),
                        description: t('tailor.promptOptions.full.description'),
                      },
                    ]
              }
              value={selectedPromptId}
              onChange={(value) => {
                hasUserSelectedPrompt.current = true;
                setSelectedPromptId(value);
              }}
              label={t('tailor.promptLabel')}
              description={t('tailor.promptDescription')}
              disabled={isAddingToQueue || promptLoading}
            />

            {/* Rate limit cooldown delay */}
            <div className="border-2 border-black bg-white p-4 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-xs font-bold uppercase tracking-wider text-black">
                    Cooldown Delay Between Resumes
                  </p>
                  <p className="font-mono text-xs text-gray-600 mt-0.5">
                    Pause time between jobs to prevent API rate limit (429) errors.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {[3, 5, 10, 15, 30].map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      onClick={() => setRateLimitSeconds(sec)}
                      className={`px-2.5 py-1 font-mono text-xs font-bold border transition-colors ${
                        rateLimitSeconds === sec
                          ? 'bg-blue-700 text-white border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]'
                          : 'bg-gray-100 text-gray-700 border-gray-400 hover:bg-gray-200'
                      }`}
                    >
                      {sec}s
                    </button>
                  ))}
                  <div className="flex items-center ml-2 border border-black bg-white px-2 py-1">
                    <input
                      type="number"
                      min={0}
                      max={120}
                      value={rateLimitSeconds}
                      onChange={(e) => setRateLimitSeconds(Math.max(0, Number(e.target.value)))}
                      className="w-12 font-mono text-xs text-center outline-none"
                    />
                    <span className="font-mono text-xs text-gray-500">s</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Single Job Description Input Card */}
            <div className="space-y-4 border-2 border-black bg-white p-5 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
              <div className="flex items-center justify-between">
                <label className="font-mono text-xs font-bold uppercase tracking-wider text-black flex items-center gap-2">
                  <Briefcase className="w-4 h-4 text-blue-700" />
                  Job Description Input
                </label>
                <span className="font-mono text-xs text-gray-500">
                  {queueInput.length} chars
                </span>
              </div>

              <Textarea
                placeholder="Paste a single job description here..."
                className="min-h-[200px] font-mono text-sm bg-[#F0F0E8] border-2 border-black focus:ring-0 focus:border-blue-700 resize-none p-3.5 rounded-none"
                value={queueInput}
                onChange={(e) => handleQueueInputChange(e.target.value)}
                onKeyDown={handleTextareaKeyDown}
                disabled={isAddingToQueue}
              />

              {/* Extracted Metadata (Role, Company, Job ID) */}
              <div className="border border-black bg-[#FAF9F5] p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] font-bold uppercase text-gray-700 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-blue-700" />
                    Detected Job Details (Zero LLM Calls):
                  </span>
                  <span className="font-mono text-[10px] text-gray-400">
                    Auto-extracted • Edit if needed
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="flex items-center border border-gray-300 bg-white px-2.5 py-1.5 focus-within:border-black">
                    <Briefcase className="w-3.5 h-3.5 text-gray-400 mr-2 shrink-0" />
                    <input
                      type="text"
                      placeholder="Role (e.g. Frontend Dev)"
                      value={queueRole}
                      onChange={(e) => setQueueRole(e.target.value)}
                      className="w-full font-mono text-xs outline-none bg-transparent"
                    />
                  </div>

                  <div className="flex items-center border border-gray-300 bg-white px-2.5 py-1.5 focus-within:border-black">
                    <Building2 className="w-3.5 h-3.5 text-gray-400 mr-2 shrink-0" />
                    <input
                      type="text"
                      placeholder="Company Name"
                      value={queueCompany}
                      onChange={(e) => setQueueCompany(e.target.value)}
                      className="w-full font-mono text-xs outline-none bg-transparent"
                    />
                  </div>

                  <div className="flex items-center border border-gray-300 bg-white px-2.5 py-1.5 focus-within:border-black">
                    <Hash className="w-3.5 h-3.5 text-gray-400 mr-2 shrink-0" />
                    <input
                      type="text"
                      placeholder="Job / Req ID"
                      value={queueJobReqId}
                      onChange={(e) => setQueueJobReqId(e.target.value)}
                      className="w-full font-mono text-xs outline-none bg-transparent"
                    />
                  </div>
                </div>
              </div>

              {queueError && (
                <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs font-mono flex items-center gap-2">
                  <span>!</span> {queueError}
                </div>
              )}

              {queueSuccessMessage && (
                <div className="p-3 bg-green-50 border border-green-300 text-green-800 text-xs font-mono flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-700 shrink-0" />
                  <span>{queueSuccessMessage}</span>
                </div>
              )}

              <Button
                size="lg"
                onClick={handleAddToQueue}
                disabled={isAddingToQueue || !queueInput.trim() || !isLlmConfigured}
                className="w-full font-mono font-bold"
              >
                {isAddingToQueue ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Adding to Queue...
                  </>
                ) : !isLlmConfigured ? (
                  t('tailor.configureApiKeyFirst')
                ) : (
                  <>
                    <Plus className="w-4 h-4 mr-2" />
                    Add to Tailoring Queue
                  </>
                )}
              </Button>
            </div>

            {/* Live Queue Monitor List */}
            <div className="border-2 border-black bg-white p-5 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b-2 border-black pb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-serif text-lg font-bold uppercase tracking-tight">
                      Tailoring Queue
                    </h2>
                    <span className="font-mono text-xs bg-black text-white px-2 py-0.5 font-bold">
                      {queueItems.length} {queueItems.length === 1 ? 'Job' : 'Jobs'}
                    </span>
                  </div>
                  <p className="font-mono text-xs text-gray-500 mt-1">
                    Cooldown: {rateLimitSeconds}s between jobs • Sequential background generation
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefreshQueue}
                    disabled={isRefreshingQueue}
                    className="font-mono text-xs h-8"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 mr-1 ${isRefreshingQueue ? 'animate-spin' : ''}`} />
                    Refresh
                  </Button>

                  {queueItems.some((i) => i.status === 'completed') && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleClearCompleted}
                      className="font-mono text-xs h-8 text-gray-700 hover:text-black"
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1" />
                      Clear Completed
                    </Button>
                  )}
                </div>
              </div>

              {/* Items List */}
              {queueItems.length === 0 ? (
                <div className="border-2 border-dashed border-gray-300 p-8 text-center bg-[#FAF9F5]">
                  <Clock className="w-8 h-8 text-gray-400 mx-auto mb-2 opacity-60" />
                  <p className="font-mono text-xs font-bold text-gray-600 uppercase">
                    No jobs in queue yet
                  </p>
                  <p className="font-mono text-xs text-gray-400 mt-1">
                    Paste a job description above and click &quot;Add to Tailoring Queue&quot;
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-200 border border-black max-h-[460px] overflow-y-auto">
                  {queueItems.map((item, idx) => {
                    const titleText = item.title || item.role || 'Job Position';
                    const companyText = item.company ? `@ ${item.company}` : '';
                    return (
                      <div
                        key={item.item_id || idx}
                        className={`p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                          item.status === 'processing'
                            ? 'bg-blue-50/70 border-l-4 border-l-blue-600'
                            : item.status === 'completed'
                            ? 'bg-white border-l-4 border-l-green-600'
                            : item.status === 'failed'
                            ? 'bg-red-50/60 border-l-4 border-l-red-600'
                            : 'bg-gray-50 border-l-4 border-l-gray-400'
                        }`}
                      >
                        <div className="flex-1 min-w-0 pr-2">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="font-mono text-xs font-bold text-black">
                              {titleText} {companyText}
                            </span>
                            {item.job_req_id && (
                              <span className="font-mono text-[10px] bg-gray-100 text-gray-600 border border-gray-300 px-1.5 py-0.5">
                                ID: {item.job_req_id}
                              </span>
                            )}
                            <span
                              className={`px-1.5 py-0.5 font-mono text-[10px] uppercase font-bold border ml-auto sm:ml-0 ${
                                item.status === 'completed'
                                  ? 'bg-green-100 text-green-800 border-green-700'
                                  : item.status === 'processing'
                                  ? 'bg-blue-100 text-blue-800 border-blue-700 animate-pulse'
                                  : item.status === 'failed'
                                  ? 'bg-red-100 text-red-800 border-red-700'
                                  : 'bg-gray-200 text-gray-700 border-gray-400'
                              }`}
                            >
                              {item.status}
                            </span>
                          </div>

                          <p className="font-mono text-xs text-gray-600 truncate">
                            {item.job_description_snippet || 'Job Description'}
                          </p>

                          {item.error && (
                            <p className="font-mono text-[11px] text-red-600 mt-1">
                              Error: {item.error}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {item.status === 'completed' && item.tailored_resume_id && (
                            <Link
                              href={`/resumes/${item.tailored_resume_id}`}
                              className="inline-flex items-center gap-1 px-3 py-1.5 bg-black text-white font-mono text-xs font-bold uppercase hover:bg-blue-700 transition-colors"
                            >
                              View Resume <ExternalLink className="w-3 h-3" />
                            </Link>
                          )}
                          {item.status === 'processing' && (
                            <span className="inline-flex items-center gap-1.5 font-mono text-xs font-bold text-blue-700 px-2 py-1 bg-blue-50 border border-blue-200">
                              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Tailoring...
                            </span>
                          )}
                          {item.status === 'pending' && (
                            <span className="inline-flex items-center gap-1 font-mono text-xs text-gray-500 px-2 py-1 bg-gray-100 border border-gray-200">
                              <Clock className="w-3.5 h-3.5" /> Queued
                            </span>
                          )}

                          {item.status !== 'processing' && (
                            <button
                              type="button"
                              title="Remove from queue"
                              onClick={() => handleDeleteQueueItem(item.item_id)}
                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 border border-transparent hover:border-red-200 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Diff preview modal */}
      {showDiffModal && pendingResult && (
        <DiffPreviewModal
          isOpen={showDiffModal}
          isConfirming={isConfirming}
          onClose={handleCloseDiffModal}
          onReject={handleRejectChanges}
          onConfirm={handleConfirmChanges}
          diffSummary={pendingResult?.data?.diff_summary}
          detailedChanges={pendingResult?.data?.detailed_changes}
          errorMessage={diffConfirmError ?? undefined}
        />
      )}

      <ConfirmDialog
        open={showRegenerateDialog}
        onOpenChange={setShowRegenerateDialog}
        title={t('tailor.regenerateDialog.title')}
        description={t('tailor.regenerateDialog.description')}
        confirmLabel={t('tailor.regenerateDialog.confirmLabel')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        onConfirm={handleRegenerateConfirm}
      />

      <ConfirmDialog
        open={showMissingDiffDialog}
        onOpenChange={(open) => {
          if (!open) {
            handleCloseMissingDiffDialog();
          }
        }}
        title={t('tailor.missingDiffDialog.title')}
        description={t('tailor.missingDiffDialog.description')}
        confirmLabel={t('tailor.missingDiffDialog.confirmLabel')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        closeOnConfirm={false}
        onConfirm={handleMissingDiffConfirm}
        onCancel={handleCloseMissingDiffDialog}
        confirmDisabled={isLoading || !missingDiffResult}
        errorMessage={missingDiffError ?? undefined}
      />
    </div>
  );
}
