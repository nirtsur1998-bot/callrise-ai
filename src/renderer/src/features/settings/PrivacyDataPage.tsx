import { PrivacyNoticeCard } from './PrivacyNoticeCard'
import { BackupCard } from '@renderer/features/backup/BackupCard'

export function PrivacyDataPage(): React.JSX.Element {
  return (
    <>
      <PrivacyNoticeCard />
      <BackupCard />
    </>
  )
}
