import { planAccountProvision } from '../src/account-plan.ts'
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

console.log('account-test: provision plan, guest copy choice, database names, study lock: ok')
