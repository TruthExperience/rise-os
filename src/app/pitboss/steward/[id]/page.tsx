'use client'

import { useParams } from 'next/navigation'
import { IncidentDetail } from '@/components/pitboss/IncidentDetail'

export default function Page() {
  const { id } = useParams<{ id: string }>()
  return <IncidentDetail id={id} />
}
