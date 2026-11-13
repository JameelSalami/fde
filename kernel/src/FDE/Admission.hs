{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE RecordWildCards #-}
-- Pure W1 evidence admission. Authentication is performed by the host; this
-- module checks the bounded contract over its independently verified receipts.
module FDE.Admission
  ( Context(..), Receipt(..), Member(..), Admission(..), Snapshot(..)
  , admit, replay, expectedMembers
  ) where
import Data.List (nub,sortOn)
import Data.Text (Text)
import qualified Data.Text as T
import FDE.Kernel

data Context = Context
  { caseId :: Text, candidateSetId :: Text, admissionId :: Text
  , assessmentId :: Text, evaluationId :: Text
  , policyId :: Text, mappingId :: Text, kernelContract :: Text
  } deriving (Eq,Show)

data Receipt = Receipt
  { receiptId :: Text, receiptRole :: Text, sourceInstance :: Text
  , sourceNativeId :: Text, sourceRevision :: Text, receiptObservedAt :: Text
  , querySha256 :: Text, authentication :: Text
  } deriving (Eq,Show)

data Member = Member
  { candidateId :: Text, memberRole :: Text, memberKind :: Text
  , memberReceiptId :: Text, memberNativeId :: Text, memberRevision :: Text
  , memberQuantity :: Text, memberUnit :: Text
  } deriving (Eq,Show)

data Admission = Admission
  { context :: Context, pinnedInput :: CompileInput
  , receipts :: [Receipt], members :: [Member]
  } deriving (Eq,Show)

data Snapshot = Snapshot
  { admitted :: Admission, evidenceGrade :: Text, decision :: Decision
  } deriving (Eq,Show)

identity :: Text -> Bool
identity t = not (T.null t) && T.length t <= 160 &&
  T.all (\c -> (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
               (c >= '0' && c <= '9') || elem c (".:_/-" :: String)) t

expectedMembers :: Context -> CompileInput -> [Receipt] -> [Member]
expectedMembers c sources rs =
  [ Member (candidateSetId c <> "/" <> r <> "." <> k) r k
      (receiptId rc) (nativeId src) (revision src) qty (unit src)
  | (r,src) <- [("erp",erp sources),("mes",mes sources)]
  , rc <- rs, receiptRole rc == r
  , (k,qty) <- [("plan",planned src),("report",reported src)] ]

sourceMatches :: Source -> Receipt -> Bool
sourceMatches src rc =
  receiptRole rc == role src && sourceInstance rc == instanceId src &&
  sourceNativeId rc == nativeId src && sourceRevision rc == revision src &&
  receiptObservedAt rc == observedAt src && querySha256 rc == queryDigest src

authMatches :: Source -> Receipt -> Bool
authMatches src rc =
  (sourceClass src == "isolated-synthetic-native" && authentication rc == "tls13-read-only") ||
  (sourceClass src == "handwritten-fixture" && authentication rc == "fixture")

admit :: Admission -> Either Text Snapshot
admit a@Admission{..}
  | policyId context /= "fde.w1.lab-review/v1" = Left "unsupported-admission-policy"
  | mappingId context /= "fde.w1.synthetic-pcs-Nos/v1" = Left "unsupported-mapping-policy"
  | kernelContract context /= "fde.semantic-w1/v1" = Left "incompatible-kernel-contract"
  | not (all identity ids) || length (nub ids) /= length ids = Left "invalid-admission-identities"
  | sortOn receiptRole receipts `rolesAreNot` ["erp","mes"] = Left "incomplete-source-receipts"
  | length (nub (map receiptId receipts)) /= 2 ||
    any (`elem` ids) (map receiptId receipts) ||
    not (all (identity . receiptId) receipts) = Left "invalid-receipt-identities"
  | sourceClass (erp pinnedInput) /= sourceClass (mes pinnedInput) = Left "mixed-evidence-grades"
  | not (and [sourceMatches src rc | (src,rc) <- matched]) = Left "source-receipt-mismatch"
  | not (and [authMatches src rc | (src,rc) <- matched]) = Left "unverified-source-authentication"
  | length members /= 4 || length (nub (map candidateId members)) /= 4 = Left "incomplete-candidate-set"
  | sortOn candidateId members /= sortOn candidateId (expectedMembers context pinnedInput receipts) =
      Left "candidate-content-mismatch"
  | otherwise = do
      compiled <- compile pinnedInput
      let normalized = a { receipts=sortOn receiptRole receipts, members=sortOn candidateId members }
          grade = if sourceClass (erp pinnedInput) == "isolated-synthetic-native"
                    then "authenticated-lab-review" else "fixture-demonstration"
      pure Snapshot { admitted=normalized, evidenceGrade=grade, decision=compiled }
  where
    ids = [caseId context,candidateSetId context,admissionId context,assessmentId context,evaluationId context]
    rolesAreNot rs names = map receiptRole rs /= names
    matched = [(src,rc) | src <- [erp pinnedInput,mes pinnedInput], rc <- receipts, receiptRole rc == role src]

-- Replay is over authenticated pinned custody; neither argument authenticates
-- itself. Recompute all interpretation and compare the entire admitted result.
replay :: Admission -> Snapshot -> Either Text Snapshot
replay a expected = do
  actual <- admit a
  if actual == expected then Right actual else Left "pinned-replay-mismatch"
