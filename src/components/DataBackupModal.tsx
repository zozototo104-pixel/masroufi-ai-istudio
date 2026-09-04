import React, { useState, useRef } from 'react';
import { 
  X, Download, Upload, FileJson, FileSpreadsheet, 
  Database, RefreshCw, CheckCircle2, AlertTriangle, 
  ShieldCheck, ArrowDownCircle, ArrowUpCircle, HardDrive, Trash2
} from 'lucide-react';
import { 
  exportTransactionsToCSV, 
  triggerFileDownload, 
  parseCSVToTransactions,
  BackupDataPayload 
} from '../lib/dataUtils';

interface DataBackupModalProps {
  isOpen: boolean;
  onClose: () => void;
  idToken: string | null;
  userName: string;
  transactionsCount: number;
  budgetsCount: number;
  commitmentsCount: number;
  reportsCount: number;
  onRefreshData: () => void;
}

export const DataBackupModal: React.FC<DataBackupModalProps> = ({
  isOpen,
  onClose,
  idToken,
  userName,
  transactionsCount,
  budgetsCount,
  commitmentsCount,
  reportsCount,
  onRefreshData
}) => {
  const [activeTab, setActiveTab] = useState<'export' | 'import' | 'wipe'>('export');
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isWiping, setIsWiping] = useState(false);
  const [showWipeConfirm, setShowWipeConfirm] = useState(false);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  
  // Staged File preview
  const [stagedFile, setStagedFile] = useState<{
    name: string;
    type: 'json' | 'csv';
    data: any;
    summary: string;
  } | null>(null);

  const jsonInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  // Export Full JSON
  const handleExportJSON = async () => {
    if (!idToken) return;
    setIsExporting(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/data/export', {
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      if (!res.ok) throw new Error('فشل جلب النسخة الاحتياطية من السحابة.');
      const data: BackupDataPayload = await res.json();
      
      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = `masrofi-backup-${dateStr}.json`;
      triggerFileDownload(JSON.stringify(data, null, 2), fileName, 'application/json');
      
      setStatusMessage({
        type: 'success',
        text: `تم تصدير النسخة الاحتياطية الشاملة بنجاح (${data.transactions?.length || 0} عملية، ${Object.keys(data.budgets || {}).length} موازنة).`
      });
    } catch (err: any) {
      console.error(err);
      setStatusMessage({
        type: 'error',
        text: 'حدث خطأ أثناء تصدير البيانات: ' + (err.message || 'فشل الاتصال')
      });
    } finally {
      setIsExporting(false);
    }
  };

  // Export CSV (Excel)
  const handleExportCSV = async () => {
    if (!idToken) return;
    setIsExporting(true);
    setStatusMessage(null);
    try {
      const res = await fetch('/api/transactions', {
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      if (!res.ok) throw new Error('فشل جلب العمليات المالية.');
      const data = await res.json();
      const transactions = data.transactions || [];
      
      const csvData = exportTransactionsToCSV(transactions, userName);
      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = `masrofi-transactions-${dateStr}.csv`;
      triggerFileDownload(csvData, fileName, 'text/csv');
      
      setStatusMessage({
        type: 'success',
        text: `تم تصدير ملف الإكسل (CSV) بنجاح ويحتوي على ${transactions.length} عملية مالية منسقة.`
      });
    } catch (err: any) {
      console.error(err);
      setStatusMessage({
        type: 'error',
        text: 'حدث خطأ أثناء تصدير ملف الإكسل: ' + (err.message || 'فشل الاتصال')
      });
    } finally {
      setIsExporting(false);
    }
  };

  // Handle JSON File selection
  const handleJSONFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        const parsed = JSON.parse(content);
        
        let txCount = 0;
        let bgCount = 0;
        let cmCount = 0;

        if (Array.isArray(parsed)) {
          txCount = parsed.length;
        } else if (typeof parsed === 'object' && parsed !== null) {
          txCount = Array.isArray(parsed.transactions) ? parsed.transactions.length : 0;
          bgCount = parsed.budgets ? Object.keys(parsed.budgets).length : 0;
          cmCount = Array.isArray(parsed.commitments) ? parsed.commitments.length : 0;
        }

        setStagedFile({
          name: file.name,
          type: 'json',
          data: parsed,
          summary: `يحتوي الملف على ${txCount} عملية مالية، ${bgCount} موازنة، ${cmCount} التزام مجدول.`
        });
        setStatusMessage(null);
      } catch (err) {
        setStatusMessage({
          type: 'error',
          text: 'الملف المرفوع ليس ملف JSON صالح أو به أخطاء في التنسيق.'
        });
      }
    };
    reader.readAsText(file);
    // Reset file input
    if (e.target) e.target.value = '';
  };

  // Handle CSV File selection
  const handleCSVFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        const transactions = parseCSVToTransactions(content);
        if (transactions.length === 0) {
          throw new Error('لم يتم العثور على أية عمليات صالحة في ملف CSV.');
        }

        setStagedFile({
          name: file.name,
          type: 'csv',
          data: { transactions },
          summary: `تم قراءة ${transactions.length} عملية مالية جاهزة للاستيراد.`
        });
        setStatusMessage(null);
      } catch (err: any) {
        setStatusMessage({
          type: 'error',
          text: 'خطأ في معالجة ملف CSV: ' + (err.message || 'تأكد من تنسيق الأعمدة')
        });
      }
    };
    reader.readAsText(file);
    if (e.target) e.target.value = '';
  };

  // Execute Import
  const handleExecuteImport = async () => {
    if (!idToken || !stagedFile) return;

    if (importMode === 'replace') {
      const confirmed = window.confirm(
        '⚠️ تحذير: خيار "الاستبدال الكامل" سيقوم بمسح العمليات والالتزامات الحالية ووضع بيانات النسخة الاحتياطية بدلاً منها. هل تود المتابعة؟'
      );
      if (!confirmed) return;
    }

    setIsImporting(true);
    setStatusMessage(null);

    try {
      const res = await fetch('/api/data/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          payload: stagedFile.data,
          mode: importMode
        })
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'فشل استيراد البيانات إلى السحابة.');
      }

      setStatusMessage({
        type: 'success',
        text: data.message || `تم استيراد البيانات بنجاح (${data.counts?.transactions || 0} عملية مالية).`
      });

      setStagedFile(null);
      onRefreshData();
      window.dispatchEvent(new CustomEvent('masrofi:refresh'));
    } catch (err: any) {
      console.error(err);
      setStatusMessage({
        type: 'error',
        text: 'حدث خطأ أثناء الاستيراد: ' + (err.message || 'فشل الاتصال')
      });
    } finally {
      setIsImporting(false);
    }
  };

  // Execute Data Wipe
  const handleExecuteWipe = async () => {
    if (!idToken) return;

    if (!showWipeConfirm) {
      setShowWipeConfirm(true);
      return;
    }

    setIsWiping(true);
    setStatusMessage(null);

    try {
      const res = await fetch('/api/data/wipe', {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${idToken}`
        }
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'فشل مسح البيانات.');
      }

      setStatusMessage({
        type: 'success',
        text: 'تم مسح وتصفير كافة البيانات بنجاح، والنظام الآن فارغ ونظيف بالكامل.'
      });

      onRefreshData();
      window.dispatchEvent(new CustomEvent('masrofi:refresh'));
    } catch (err: any) {
      console.error(err);
      setStatusMessage({
        type: 'error',
        text: 'حدث خطأ أثناء مسح البيانات: ' + (err.message || 'فشل الاتصال')
      });
    } finally {
      setIsWiping(false);
      setShowWipeConfirm(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-md z-[110] flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-2xl max-h-[92vh] flex flex-col p-6 shadow-2xl relative">
        
        {/* Close Button */}
        <button 
          onClick={onClose} 
          className="absolute top-4 left-4 p-2 bg-slate-800 rounded-full text-slate-400 hover:bg-slate-700 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="p-3 bg-emerald-500/20 text-emerald-400 rounded-2xl border border-emerald-500/30">
            <HardDrive className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              إدارة ونسخ البيانات (استيراد وتصدير)
            </h2>
            <p className="text-xs text-slate-400">
              احفظ نسخة احتياطية آمنة على جهازك أو انقل بياناتك إلى إكسل دون أي فقدان
            </p>
          </div>
        </div>

        {/* Live Data Summary Card */}
        <div className="bg-slate-950/80 border border-slate-800 p-3.5 rounded-2xl mb-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
          <div className="bg-slate-900/60 p-2 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[11px]">العمليات الحالية</span>
            <strong className="text-white text-sm font-mono">{transactionsCount}</strong>
          </div>
          <div className="bg-slate-900/60 p-2 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[11px]">الموازنات</span>
            <strong className="text-amber-400 text-sm font-mono">{budgetsCount}</strong>
          </div>
          <div className="bg-slate-900/60 p-2 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[11px]">الالتزامات</span>
            <strong className="text-sky-400 text-sm font-mono">{commitmentsCount}</strong>
          </div>
          <div className="bg-slate-900/60 p-2 rounded-xl border border-slate-800">
            <span className="text-slate-400 block text-[11px]">التقارير</span>
            <strong className="text-emerald-400 text-sm font-mono">{reportsCount}</strong>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-800 mb-5">
          <button
            onClick={() => { setActiveTab('export'); setStatusMessage(null); }}
            className={`flex-1 py-2.5 font-bold text-xs sm:text-sm flex items-center justify-center gap-1.5 border-b-2 transition-all ${
              activeTab === 'export'
                ? 'border-emerald-500 text-emerald-400 bg-emerald-500/10 rounded-t-xl'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Download className="w-4 h-4" /> تصدير (Export)
          </button>
          <button
            onClick={() => { setActiveTab('import'); setStatusMessage(null); }}
            className={`flex-1 py-2.5 font-bold text-xs sm:text-sm flex items-center justify-center gap-1.5 border-b-2 transition-all ${
              activeTab === 'import'
                ? 'border-emerald-500 text-emerald-400 bg-emerald-500/10 rounded-t-xl'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Upload className="w-4 h-4" /> استيراد (Import)
          </button>
          <button
            onClick={() => { setActiveTab('wipe'); setStatusMessage(null); }}
            className={`flex-1 py-2.5 font-bold text-xs sm:text-sm flex items-center justify-center gap-1.5 border-b-2 transition-all ${
              activeTab === 'wipe'
                ? 'border-rose-500 text-rose-400 bg-rose-500/10 rounded-t-xl'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Trash2 className="w-4 h-4" /> تصفير شامل (Wipe)
          </button>
        </div>

        {/* Status Message Alert */}
        {statusMessage && (
          <div className={`p-3.5 rounded-2xl mb-4 text-xs font-medium flex items-center gap-2.5 ${
            statusMessage.type === 'success'
              ? 'bg-emerald-950/50 border border-emerald-500/30 text-emerald-300'
              : statusMessage.type === 'error'
                ? 'bg-rose-950/50 border border-rose-500/30 text-rose-300'
                : 'bg-blue-950/50 border border-blue-500/30 text-blue-300'
          }`}>
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}

        {/* Tab Content */}
        <div className="overflow-y-auto flex-1 pr-1 space-y-4">
          
          {/* EXPORT TAB */}
          {activeTab === 'export' && (
            <div className="space-y-4">
              
              {/* Option 1: Full JSON Backup */}
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4.5 hover:border-emerald-500/30 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="p-2.5 bg-emerald-500/10 text-emerald-400 rounded-xl border border-emerald-500/20 shrink-0">
                      <FileJson className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-bold text-white text-sm sm:text-base">
                        نسخة احتياطية شاملة (JSON Backup)
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                        ملف هيكلي كامل يشمل كافة المعاملات المالية، سقوف الموازنات، الالتزامات المجدولة، التقارير والذاكرة المالية.
                      </p>
                      <div className="flex items-center gap-2 mt-2 text-[11px] text-slate-500">
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                        <span>مناسب للاسترجاع على أي هاتف أو متصفح بنقرة واحدة</span>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={handleExportJSON}
                    disabled={isExporting}
                    className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-xs flex items-center gap-1.5 shrink-0 transition-all shadow-md shadow-emerald-950/40 disabled:opacity-50"
                  >
                    {isExporting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    <span>تحميل JSON</span>
                  </button>
                </div>
              </div>

              {/* Option 2: Excel / CSV Export */}
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4.5 hover:border-blue-500/30 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="p-2.5 bg-blue-500/10 text-blue-400 rounded-xl border border-blue-500/20 shrink-0">
                      <FileSpreadsheet className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-bold text-white text-sm sm:text-base">
                        تصدير كجدول إكسل (Excel / CSV)
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                        ملف جدول بيانات بترميز عربي منسق متوافق مباشرة مع Microsoft Excel و Google Sheets، مع تقسيم دقيق للأعمدة والتواريخ والمبالغ.
                      </p>
                      <div className="flex items-center gap-2 mt-2 text-[11px] text-slate-500">
                        <span>📊 يدعم الفرز والتحليل والطباعة المباشرة من برامج الجداول</span>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={handleExportCSV}
                    disabled={isExporting}
                    className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold text-xs flex items-center gap-1.5 shrink-0 transition-all shadow-md shadow-blue-950/40 disabled:opacity-50"
                  >
                    {isExporting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
                    <span>تحميل Excel</span>
                  </button>
                </div>
              </div>

            </div>
          )}

          {/* IMPORT TAB */}
          {activeTab === 'import' && (
            <div className="space-y-4">
              
              {/* Staged File Ready to Import */}
              {stagedFile ? (
                <div className="bg-slate-950 border-2 border-emerald-500/40 rounded-2xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                      <span className="font-bold text-white text-sm">ملف جاهز للاستيراد:</span>
                      <code className="text-xs bg-slate-800 px-2 py-0.5 rounded text-emerald-300 font-mono">
                        {stagedFile.name}
                      </code>
                    </div>
                    <button 
                      onClick={() => setStagedFile(null)}
                      className="text-xs text-slate-400 hover:text-rose-400 underline"
                    >
                      إلغاء الملف
                    </button>
                  </div>

                  <p className="text-xs text-slate-300 bg-slate-900/80 p-2.5 rounded-xl border border-slate-800">
                    {stagedFile.summary}
                  </p>

                  {/* Mode Selector */}
                  <div className="pt-2 border-t border-slate-800">
                    <label className="block text-xs font-bold text-slate-300 mb-2">طريقة الاستيراد:</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <label className={`p-3 rounded-xl border cursor-pointer transition-all flex items-start gap-2.5 ${
                        importMode === 'merge' 
                          ? 'bg-emerald-950/30 border-emerald-500/50 text-white' 
                          : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:bg-slate-900'
                      }`}>
                        <input 
                          type="radio" 
                          name="importMode" 
                          value="merge" 
                          checked={importMode === 'merge'} 
                          onChange={() => setImportMode('merge')} 
                          className="mt-0.5"
                        />
                        <div>
                          <strong className="block text-xs text-emerald-400 font-bold">🔄 دمج مع البيانات الحالية (Merge)</strong>
                          <span className="text-[11px] text-slate-400">إضافة العمليات والموازنات الجديدة دون حذف أي من بياناتك الحالية (موصى به).</span>
                        </div>
                      </label>

                      <label className={`p-3 rounded-xl border cursor-pointer transition-all flex items-start gap-2.5 ${
                        importMode === 'replace' 
                          ? 'bg-rose-950/30 border-rose-500/50 text-white' 
                          : 'bg-slate-900/50 border-slate-800 text-slate-400 hover:bg-slate-900'
                      }`}>
                        <input 
                          type="radio" 
                          name="importMode" 
                          value="replace" 
                          checked={importMode === 'replace'} 
                          onChange={() => setImportMode('replace')} 
                          className="mt-0.5"
                        />
                        <div>
                          <strong className="block text-xs text-rose-400 font-bold">⚠️ استبدال كامل (Replace All)</strong>
                          <span className="text-[11px] text-slate-400">مسح كافة البيانات والبدء بحالة مطابقة للنسخة الاحتياطية تماماً.</span>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Confirmation / Submit Button */}
                  <button
                    onClick={handleExecuteImport}
                    disabled={isImporting}
                    className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/40 transition-all disabled:opacity-50 mt-3"
                  >
                    {isImporting ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>جاري استيراد وحفظ البيانات في السحابة...</span>
                      </>
                    ) : (
                      <>
                        <Upload className="w-4 h-4" />
                        <span>تأكيد استيراد البيانات الآن</span>
                      </>
                    )}
                  </button>
                </div>
              ) : (
                /* Upload Buttons */
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  
                  {/* JSON Upload Tile */}
                  <div 
                    onClick={() => jsonInputRef.current?.click()}
                    className="bg-slate-950/60 border border-slate-800 border-dashed hover:border-emerald-500 rounded-2xl p-5 text-center cursor-pointer transition-all hover:bg-emerald-950/10 group flex flex-col items-center justify-center min-h-[160px]"
                  >
                    <input 
                      type="file" 
                      ref={jsonInputRef} 
                      onChange={handleJSONFileSelected} 
                      accept=".json,application/json" 
                      className="hidden" 
                    />
                    <div className="p-3 bg-emerald-500/10 text-emerald-400 rounded-2xl border border-emerald-500/20 group-hover:scale-110 transition-transform mb-3">
                      <FileJson className="w-6 h-6" />
                    </div>
                    <h4 className="font-bold text-white text-sm mb-1">استيراد نسخة احتياطية (.json)</h4>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      اضغط لاختيار ملف JSON تم تصديره مسبقاً من التطبيق
                    </p>
                  </div>

                  {/* CSV Upload Tile */}
                  <div 
                    onClick={() => csvInputRef.current?.click()}
                    className="bg-slate-950/60 border border-slate-800 border-dashed hover:border-blue-500 rounded-2xl p-5 text-center cursor-pointer transition-all hover:bg-blue-950/10 group flex flex-col items-center justify-center min-h-[160px]"
                  >
                    <input 
                      type="file" 
                      ref={csvInputRef} 
                      onChange={handleCSVFileSelected} 
                      accept=".csv,text/csv" 
                      className="hidden" 
                    />
                    <div className="p-3 bg-blue-500/10 text-blue-400 rounded-2xl border border-blue-500/20 group-hover:scale-110 transition-transform mb-3">
                      <FileSpreadsheet className="w-6 h-6" />
                    </div>
                    <h4 className="font-bold text-white text-sm mb-1">استيراد من ملف إكسل (.csv)</h4>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      اضغط لاختيار ملف معاملات مجدولة أو مسودة مصرفية
                    </p>
                  </div>

                </div>
              )}

              {/* Helpful Notes */}
              <div className="bg-slate-950/40 border border-slate-800/80 rounded-xl p-3 text-[11px] text-slate-400 space-y-1">
                <p className="font-bold text-slate-300 flex items-center gap-1.5">
                  <span>💡</span> نصائح هامة للاستيراد:
                </p>
                <p>• يمكنك استيراد النسخة الاحتياطية على أي متصفح أو هاتف آخر بمجرد تسجيل الدخول بحسابك.</p>
                <p>• ملفات JSON تحفظ كافة تفاصيل العمليات والموازنات وتضمن مطابقة 100%.</p>
              </div>

            </div>
          )}

          {/* ==================== WIPE / CLEAR DATA TAB ==================== */}
          {activeTab === 'wipe' && (
            <div className="space-y-4 animate-in fade-in duration-200">
              
              <div className="bg-rose-950/20 border border-rose-500/30 rounded-2xl p-4 text-center space-y-2">
                <div className="w-12 h-12 bg-rose-500/20 text-rose-400 rounded-full flex items-center justify-center mx-auto border border-rose-500/30">
                  <Trash2 className="w-6 h-6" />
                </div>
                <h3 className="text-base font-bold text-rose-300">مسح وتصفير كافة البيانات من النظام</h3>
                <p className="text-xs text-slate-300 max-w-md mx-auto leading-relaxed">
                  هذا الخيار يقوم بمسح شامل لكافة العمليات المالية، والالتزامات، والموازنات، والتقارير، وسجل الذاكرة من السحابة والذاكرة المحلية، ليصبح حسابك نظيفاً كلياً دون أي مزامنة تلقائية لبيانات قديمة.
                </p>
              </div>

              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-4 space-y-3">
                <h4 className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-400" /> ما الذي سيتم مسحه وتصفيره؟
                </h4>
                <ul className="text-xs text-slate-400 space-y-1.5 list-disc list-inside pr-1">
                  <li>كافة المعاملات والمصروفات والإيداعات المسجلة ({transactionsCount} عملية).</li>
                  <li>جميع سقوف الميزانيات المخصصة للأقسام.</li>
                  <li>كافة الالتزامات والأقساط المجدولة ({commitmentsCount} التزام).</li>
                  <li>كافة التقارير المالية المحفوظة ({reportsCount} تقرير).</li>
                  <li>ذاكرة وسجل المحادثات والمساعد الذكي.</li>
                </ul>
              </div>

              <div className="pt-2">
                {!showWipeConfirm ? (
                  <button
                    onClick={handleExecuteWipe}
                    disabled={isWiping}
                    className="w-full py-3.5 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl text-sm flex items-center justify-center gap-2 shadow-lg shadow-rose-950/50 transition-all disabled:opacity-50"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>تأكيد مسح كافة البيانات الآن (Wipe All Data)</span>
                  </button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-rose-400 text-xs font-bold text-center mb-1">🚨 تحذير نهائي: هل أنت متأكد تماماً؟ لا يمكن التراجع!</p>
                    <div className="flex gap-2">
                      <button
                        onClick={handleExecuteWipe}
                        disabled={isWiping}
                        className="flex-1 py-3.5 bg-rose-700 hover:bg-rose-600 text-white font-bold rounded-xl text-sm flex items-center justify-center gap-2 shadow-lg shadow-rose-950/50 transition-all disabled:opacity-50"
                      >
                        {isWiping ? (
                          <>
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            <span>جاري المسح...</span>
                          </>
                        ) : (
                          <>
                            <Trash2 className="w-4 h-4" />
                            <span>نعم، امسح كل شيء</span>
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => setShowWipeConfirm(false)}
                        disabled={isWiping}
                        className="flex-1 py-3.5 bg-slate-800 hover:bg-slate-700 text-white font-bold rounded-xl text-sm flex items-center justify-center transition-all disabled:opacity-50"
                      >
                        تراجع
                      </button>
                    </div>
                  </div>
                )}
              </div>

            </div>
          )}

        </div>

        {/* Modal Footer */}
        <div className="pt-4 mt-3 border-t border-slate-800 flex justify-between items-center text-xs text-slate-500">
          <span>نظام النسخ السحابي المشفر — مصروفي AI</span>
          <button 
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium transition-colors"
          >
            إغلاق
          </button>
        </div>

      </div>
    </div>
  );
};
