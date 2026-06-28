'use client'

import { useEffect, useState, useRef, Suspense } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter, useParams } from 'next/navigation'

const UPLOAD_ROLES = ['commissioner', 'co_owner', 'admin', 'head_steward']

interface RuleBook {
 id: string
 title: string
 document_code: string
 version: string
 status: string
 authority_level: number
 effective_date: string
 tagline: string | null
 document_url: string | null
 document_filename: string | null
 document_size_bytes: number | null
 document_uploaded_at: string | null
}

function formatBytes(bytes: number) {
 if (bytes < 1024) return `${bytes} B`
 if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
 return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string) {
 return new Date(iso).toLocaleDateString('en-GB', {
   day: 'numeric', month: 'short', year: 'numeric',
 })
}

function RulesInner() {
 const { data: session, status: authStatus } = useSession()
 const router = useRouter()
 const { id } = useParams<{ id: string }>()

 const [documents, setDocuments] = useState<RuleBook[]>([])
 const [loading, setLoading] = useState(true)
 const [canUpload, setCanUpload] = useState(false)
 const [uploadingId, setUploadingId] = useState<string | null>(null)
 const [uploadError, setUploadError] = useState<string | null>(null)
 const [uploadSuccess, setUploadSuccess] = useState<string | null>(null)
 const fileRef = useRef<HTMLInputElement>(null)
 const pendingDocId = useRef<string | null>(null)

 useEffect(() => {
   if (authStatus === 'unauthenticated') router.push('/login')
 }, [authStatus, router])

 useEffect(() => {
   if (authStatus !== 'authenticated') return
   fetchDocuments()
   checkUploadPermission()
 }, [authStatus, id])

 async function fetchDocuments(showSpinner = true) {
   if (showSpinner) setLoading(true)
   try {
     const res = await fetch(`/api/league/${id}/rules?t=${Date.now()}`, {
       cache: 'no-store',
     })
     const data = await res.json()
     setDocuments(data.documents ?? [])
   } catch {
     setDocuments([])
   } finally {
     if (showSpinner) setLoading(false)
   }
 }

 async function checkUploadPermission() {
   try {
     const res = await fetch('/api/pitboss/me/leagues')
     const data = await res.json()
     const membership = (data.leagues ?? []).find((m: any) => m.league_id === id)
     if (!membership) return
     const roles = membership.role.split(',').map((r: string) => r.trim().toLowerCase())
     setCanUpload(roles.some((r: string) => UPLOAD_ROLES.includes(r)))
   } catch {
     setCanUpload(false)
   }
 }

 function triggerUpload(docId: string) {
   pendingDocId.current = docId
   setUploadError(null)
   setUploadSuccess(null)
   fileRef.current?.click()
 }

 async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
   const file = e.target.files?.[0]
   if (!file || !pendingDocId.current) return

   const docId = pendingDocId.current
   setUploadingId(docId)
   setUploadError(null)
   setUploadSuccess(null)

   try {
     const formData = new FormData()
     formData.append('file', file)
     formData.append('rule_book_id', docId)

     const res = await fetch(`/api/league/${id}/rules`, {
       method: 'PUT',
       body: formData,
     })

     const data = await res.json()
     if (!res.ok) throw new Error(data.error ?? 'Upload failed')

     setUploadSuccess(data.document.title)

     // Await fresh fetch so UI updates before spinner clears
     await fetchDocuments(false)
   } catch (err: any) {
     setUploadError(err.message)
   } finally {
     setUploadingId(null)
     pendingDocId.current = null
     if (fileRef.current) fileRef.current.value = ''
   }
 }

 if (authStatus === 'loading' || loading) {
   return (
     <main className="flex min-h-screen items-center justify-center bg-rise-black">
       <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
     </main>
   )
 }

 return (
   <main className="min-h-screen bg-rise-black px-4 py-8 pb-24">
     <button
       onClick={() => router.back()}
       className="flex items-center gap-2 text-white/40 text-sm mb-6"
     >
       ← Back
     </button>

     <div className="mb-8">
       <h1 className="text-2xl font-black text-white">Rulebook</h1>
       <p className="text-xs text-white/30 uppercase tracking-widest mt-1">
         Official League Documents
       </p>
     </div>

     <input
       ref={fileRef}
       type="file"
       accept="application/pdf"
       className="hidden"
       onChange={handleFileChange}
     />

     {uploadError && (
       <div className="mb-4 rounded-xl border border-rise-red/40 bg-rise-red/10 px-4 py-3">
         <p className="text-rise-red text-sm">{uploadError}</p>
       </div>
     )}
     {uploadSuccess && (
       <div className="mb-4 rounded-xl border border-green-500/40 bg-green-500/10 px-4 py-3">
         <p className="text-green-400 text-sm">✓ "{uploadSuccess}" uploaded successfully</p>
       </div>
     )}

     {documents.length === 0 ? (
       <div className="flex flex-col items-center justify-center mt-20 gap-3">
         <p className="text-4xl">📖</p>
         <p className="text-white font-bold">No documents yet</p>
         <p className="text-white/30 text-sm text-center">
           No rulebooks have been uploaded for this league.
         </p>
       </div>
     ) : (
       <div className="flex flex-col gap-3">
         {documents.map((doc) => {
           const isUploading = uploadingId === doc.id
           const hasFile = !!doc.document_url

           return (
             <div
               key={doc.id}
               className="rounded-2xl border border-white/10 bg-white/5 p-4"
             >
               <div className="flex items-start justify-between gap-3 mb-2">
                 <div className="flex-1 min-w-0">
                   <p className="text-white font-bold text-sm leading-tight">{doc.title}</p>
                   <p className="text-white/30 text-[10px] uppercase tracking-widest mt-0.5">
                     {doc.document_code} · {doc.version}
                   </p>
                 </div>
                 <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full flex-shrink-0 ${
                   hasFile
                     ? 'bg-green-500/10 text-green-400'
                     : 'bg-white/5 text-white/20'
                 }`}>
                   {hasFile ? '● Available' : '○ Pending'}
                 </span>
               </div>

               {doc.tagline && (
                 <p className="text-white/40 text-xs mb-3">{doc.tagline}</p>
               )}

               <div className="flex items-center gap-3 mb-3">
                 <span className="text-white/20 text-[10px]">
                   Effective {formatDate(doc.effective_date)}
                 </span>
                 {doc.document_size_bytes && (
                   <span className="text-white/20 text-[10px]">
                     {formatBytes(doc.document_size_bytes)}
                   </span>
                 )}
                 {doc.document_uploaded_at && (
                   <span className="text-white/20 text-[10px]">
                     Uploaded {formatDate(doc.document_uploaded_at)}
                   </span>
                 )}
               </div>

               <div className="flex gap-2">
                 {hasFile && (
                   <a
                     href={doc.document_url!}
                     target="_blank"
                     rel="noreferrer"
                     className="flex-1 rounded-xl bg-rise-red/10 border border-rise-red/30 py-2.5 text-center text-xs font-bold text-rise-red"
                   >
                     📄 Open PDF
                   </a>
                 )}
                 {canUpload && (
                   <button
                     onClick={() => triggerUpload(doc.id)}
                     disabled={isUploading}
                     className={`rounded-xl border border-white/10 py-2.5 text-xs font-bold text-white/40 disabled:opacity-40 transition-colors ${
                       hasFile ? 'px-4' : 'flex-1'
                     }`}
                   >
                     {isUploading ? 'Uploading…' : hasFile ? '↑ Replace' : '↑ Upload PDF'}
                   </button>
                 )}
                 {!hasFile && !canUpload && (
                   <div className="flex-1 rounded-xl border border-white/5 py-2.5 text-center text-xs text-white/20">
                     Not yet available
                   </div>
                 )}
               </div>
             </div>
           )
         })}
       </div>
     )}
   </main>
 )
}

export default function RulesPage() {
 return (
   <Suspense fallback={
     <main className="flex min-h-screen items-center justify-center bg-rise-black">
       <div className="h-10 w-10 rounded-full border-2 border-rise-red border-t-transparent animate-spin" />
     </main>
   }>
     <RulesInner />
   </Suspense>
 )
}
