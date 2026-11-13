{-# LANGUAGE OverloadedStrings #-}
module FDE.SemanticWire (processSemantic) where
import Control.Monad (unless)
import Data.Aeson (Value(..),object,withObject,(.:),(.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (Parser,parseEither)
import Data.List (sort)
import Data.Text (Text)
import FDE.Semantic
import FDE.Wire (parseInput)

exact :: [Text] -> KM.KeyMap Value -> Parser ()
exact names obj = unless
  (sort (map Key.toText (KM.keys obj)) == sort names)
  (fail "closed-semantic-schema")

processSemantic :: Value -> Either Text Value
processSemantic candidate =
  case parseEither parser candidate of
    Left _ -> Left "invalid-semantic-request"
    Right result -> result
  where
    parser = withObject "semantic request" $ \o -> do
      schema <- o .: "schema" :: Parser Text
      case schema of
        "fde.semantic-catalog-request/v1" -> do
          exact ["schema"] o
          pure (Right (renderCatalog semanticCatalog))
        "fde.semantic-package-request/v1" -> do
          exact ["schema","case"] o
          raw <- o .: "case"
          pure $ do
            input <- parseInput raw
            renderPackage <$> buildSemanticPackage input
        "fde.claim-relation-request/v1" -> do
          exact ["schema","case","claim"] o
          raw <- o .: "case"
          rawClaim <- o .: "claim"
          pure $ do
            input <- parseInput raw
            claim <- parseClaim rawClaim
            renderClaimAssessment <$> assessClaim input claim
        _ -> fail "unsupported-semantic-request"

parseClaim :: Value -> Either Text Claim
parseClaim value =
  case parseEither parser value of
    Left _ -> Left "invalid-semantic-claim"
    Right x -> Right x
  where
    parser = withObject "semantic claim" $ \o -> do
      kind <- o .: "kind" :: Parser Text
      case kind of
        "native-reported-values" -> exact ["kind"] o >> pure NativeReportedValues
        "source-coverage-limit" -> exact ["kind"] o >> pure SourceCoverageLimit
        "physical-production-occurred" -> exact ["kind"] o >> pure PhysicalProductionOccurred
        "reported-quantity" -> do
          exact ["kind","role","quantity"] o
          ReportedQuantity <$> o .: "role" <*> o .: "quantity"
        _ -> fail "unsupported-claim-kind"

renderCatalog :: SemanticCatalog -> Value
renderCatalog c = object
  [ "schema" .= ("fde.semantic-catalog/v1" :: Text)
  , "authority" .= ("none" :: Text)
  , "modelId" .= catalogModelId c
  , "modelVersion" .= catalogModelVersion c
  , "factIds" .= catalogFactIds c
  , "constraintIds" .= catalogConstraintIds c
  , "claimKinds" .= catalogClaimKinds c
  , "mappingId" .= catalogMappingId c
  ]

renderPackage :: SemanticPackage -> Value
renderPackage p = object
  [ "schema" .= ("fde.semantic-package/v1" :: Text)
  , "authority" .= ("none" :: Text)
  , "modelId" .= semanticModelId p
  , "modelVersion" .= semanticModelVersion p
  , "facts" .= map renderFact (semanticFacts p)
  , "constraints" .= map renderConstraint (semanticConstraints p)
  , "receipts" .= map renderReceipt (semanticReceipts p)
  , "mapping" .= renderMapping (semanticMapping p)
  ]

renderFact :: SemanticFact -> Value
renderFact f = object
  [ "id" .= semanticFactId f
  , "subjectId" .= semanticSubjectId f
  , "property" .= semanticPropertyId f
  , "knowledge" .= renderKnowledge (semanticKnowledge f)
  , "evidence" .= map renderEvidence (semanticEvidence f)
  ]

renderValue :: SemanticValue -> Value
renderValue (QuantityValue value unitName) =
  object ["kind" .= ("quantity" :: Text),"value" .= value,"unit" .= unitName]
renderValue (TextValue value) =
  object ["kind" .= ("text" :: Text),"value" .= value]
renderValue (BooleanValue value) =
  object ["kind" .= ("boolean" :: Text),"value" .= value]

renderKnowledge :: Knowledge -> Value
renderKnowledge (Known value) =
  object ["kind" .= ("known" :: Text),"value" .= renderValue value]
renderKnowledge (Unknown reason) =
  object ["kind" .= ("unknown" :: Text),"reason" .= reason]
renderKnowledge (Conflicting observations) =
  object ["kind" .= ("conflicting" :: Text),"observations" .= map renderConflict observations]

renderConflict :: ConflictObservation -> Value
renderConflict c = object
  [ "value" .= renderValue (conflictValue c)
  , "evidence" .= renderEvidence (conflictEvidence c)
  ]

renderEvidence :: EvidenceBinding -> Value
renderEvidence e = object
  [ "id" .= evidenceId e
  , "role" .= evidenceRole e
  , "instance" .= evidenceInstance e
  , "nativeId" .= evidenceNativeId e
  , "revision" .= evidenceRevision e
  , "querySha256" .= evidenceQueryDigest e
  ]

renderConstraint :: Constraint -> Value
renderConstraint (RequiresKnown cid fid) =
  object ["kind" .= ("requires-known" :: Text),"id" .= cid,"factId" .= fid]
renderConstraint (SameValue cid left right) =
  object ["kind" .= ("same-value" :: Text),"id" .= cid,"leftFactId" .= left,"rightFactId" .= right]

renderReceipt :: ConstraintReceipt -> Value
renderReceipt r = object
  [ "constraintId" .= receiptConstraintId r
  , "status" .= statusText (receiptStatus r)
  , "reason" .= receiptReason r
  ]

statusText :: ConstraintStatus -> Text
statusText Satisfied = "satisfied"
statusText Violated = "violated"
statusText Indeterminate = "indeterminate"

renderMapping :: MappingReceipt -> Value
renderMapping m = object
  [ "id" .= semanticMappingId m
  , "bindingGrade" .= semanticBindingGrade m
  , "unitPolicy" .= semanticUnitPolicy m
  , "fidelity" .= case semanticMappingFidelity m of
      ProjectionOnly reason -> object
        [ "kind" .= ("projection-only" :: Text)
        , "reason" .= reason
        ]
  ]

renderClaimAssessment :: ClaimAssessment -> Value
renderClaimAssessment a = object
  [ "schema" .= ("fde.semantic-claim-assessment/v1" :: Text)
  , "authority" .= ("none" :: Text)
  , "claimId" .= assessedClaimId a
  , "claim" .= assessedClaimText a
  , "relations" .= map renderRelation (assessedRelations a)
  ]

renderRelation :: ClaimRelation -> Value
renderRelation r = object
  [ "evidenceClass" .= evidenceClassText (claimEvidenceClass r)
  , "relation" .= relationText (claimRelation r)
  , "rationale" .= claimRationale r
  ]

evidenceClassText :: EvidenceClass -> Text
evidenceClassText NativeERP = "native-erp"
evidenceClassText NativeMES = "native-mes"
evidenceClassText OtherEvidence = "other-evidence"

relationText :: Relation -> Text
relationText Supports = "supports"
relationText Contradicts = "contradicts"
relationText Related = "related"
relationText Irrelevant = "irrelevant"
