import { planAccountProvision } from '../src/account-plan.ts'
import { cancelPopupWhenPageReturns, deckOpenFailure, retryableDeckOpen, seedBeforeFirstSync } from '../src/sign-in-flow.ts'
import { copyAlreadyDecided, rememberCopyDecision, sessionCopyMode } from '../src/copy-choice.ts'
import { includeGuestVocabulary } from '../src/guest-copy.ts'
import { bindStudyDatabase, captureStudyLock, clearStudyBinding, hasStudyBinding, studyLockCurrent } from '../src/study-lock.ts'
import { accountDatabaseName, dbNameForUser, LEGACY_DB_NAME } from '../src/user.ts'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const fresh = planAccountProvision(null, 'uid-a')
assert(fresh.createPersonal && fresh.deckId === 'uid-a', 'a missing account creates its personal deck')
const legacy = planAccountProvision('legacy-deck', 'uid-a')
assert(!legacy.createPersonal && legacy.deckId === 'legacy-deck', 'a pre-written deck id is kept')
const again = planAccountProvision('uid-a', 'uid-a')
assert(!again.createPersonal && again.deckId === 'uid-a', 'an existing personal account is not created again')

assert(includeGuestVocabulary(true, false), 'a personal deck includes word-list edits without a second yes')
assert(!includeGuestVocabulary(false, false), 'a shared deck omits word-list edits until they are confirmed')
assert(includeGuestVocabulary(false, true), 'a shared deck includes word-list edits after the second yes')

const memory = () => {
  const data = new Map()
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, value) },
  }
}
const choices = memory()
const profile = 'german-flashcards:joakim'
assert(!copyAlreadyDecided(choices, 'uid-a', profile), 'a first sign-in has no stored answer')
assert(sessionCopyMode(false, 'vocabulary') === 'vocabulary', 'the first yes copies the device database')
assert(sessionCopyMode(false, 'progress') === 'progress', 'the first yes can copy progress only')
assert(sessionCopyMode(false, 'skip') === 'skip', 'not now copies nothing')
assert(sessionCopyMode(false, null) === 'skip', 'an empty device database copies nothing')
rememberCopyDecision(choices, 'uid-a', profile, 'vocabulary')
assert(copyAlreadyDecided(choices, 'uid-a', profile), 'the answer is stored for that account and database')
assert(sessionCopyMode(true, 'vocabulary') === 'skip', 'a restored session does not copy the device database again')
assert(!copyAlreadyDecided(choices, 'uid-b', profile), 'another account is still asked about this device')
assert(!copyAlreadyDecided(choices, 'uid-a', 'german-flashcards'), 'another device database is still asked')

assert(cancelPopupWhenPageReturns(true), 'an installed iPhone app can only see that the page returned')
assert(!cancelPopupWhenPageReturns(false), 'Safari keeps the Google sheet open while this page is in the background')
assert(seedBeforeFirstSync(true), 'a deck created with this sign-in is painted from the built-in seed')
assert(!seedBeforeFirstSync(false), 'an existing account waits for its server deck before seeding')
assert(retryableDeckOpen('unavailable') && retryableDeckOpen('deadline-exceeded'), 'a cold phone retries the first deck open')
assert(retryableDeckOpen('firestore/unavailable'), 'a namespaced unavailable error is retried')
assert(!retryableDeckOpen('permission-denied'), 'rules rejection is not a cold-start retry')
assert(deckOpenFailure('deadline-exceeded').includes('did not open'), 'a signed-in phone is told the deck did not open')
assert(deckOpenFailure('auth/popup-blocked').includes('Safari'), 'a blocked popup asks for Safari')
rememberCopyDecision(choices, 'uid-a', 'german-flashcards', 'skip')
assert(copyAlreadyDecided(choices, 'uid-a', profile), 'a second database keeps the first answer')
const broken = { getItem: () => '{', setItem: () => {} }
assert(copyAlreadyDecided(broken, 'uid-a', profile) === false, 'unreadable storage asks again')

const account = accountDatabaseName('uid-a')
assert(account === 'german-flashcards:account:uid-a', 'an account database is named by uid')
assert(account !== LEGACY_DB_NAME, 'an account database is not the original guest database')
assert(account !== dbNameForUser('uid-a'), 'an account database is not a name-scoped profile database')
assert(account !== dbNameForUser('joakim'), 'an account database is not an existing profile database')

clearStudyBinding()
assert(hasStudyBinding() === false, 'a cleared lock is not bound')
const open = captureStudyLock()
assert(studyLockCurrent(open), 'a fresh lock matches itself')
const signedIn = bindStudyDatabase({ uid: 'uid-a', dbName: account })
assert(hasStudyBinding(), 'sign-in binds a database')
assert(!studyLockCurrent(open), 'binding drops the previous lock')
assert(signedIn.uid === 'uid-a' && signedIn.dbName === account, 'the signed-in lock names that account database')
const guest = bindStudyDatabase({ uid: null, dbName: LEGACY_DB_NAME })
assert(!studyLockCurrent(signedIn), 'sign-out drops the account lock')
assert(guest.uid === null && guest.dbName === LEGACY_DB_NAME, 'sign-out returns to the guest database')
const other = bindStudyDatabase({ uid: 'uid-b', dbName: accountDatabaseName('uid-b') })
assert(!studyLockCurrent(guest), 'a second account drops the guest lock')
assert(other.dbName !== signedIn.dbName, 'a second uid gets its own database')
clearStudyBinding()

console.log('account-test: provision plan, guest copy choice, stored copy answer, database names, study lock: ok')
