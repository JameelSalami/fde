{-# LANGUAGE OverloadedStrings #-}
-- Pure FDE domain semantics above the narrow quantity diagnostic.
-- No JSON, SQL, clock, retrieval, model, UI or effect authority.
module FDE.Semantic
  ( SemanticValue(..),EvidenceBinding(..),ConflictObservation(..),Knowledge(..)
  , SemanticFact(..),Constraint(..),ConstraintStatus(..),ConstraintReceipt(..)
  , MappingFidelity(..),MappingReceipt(..),SemanticPackage(..),SemanticCatalog(..)
  , Claim(..),EvidenceClass(..),Relation(..),ClaimRelation(..),ClaimAssessment(..)
  , semanticCatalog,buildSemanticPackage,evaluateConstraint,assessClaim
  ) where
import Data.List (find)
import Data.Text (Text)
import FDE.Kernel

data SemanticValue
  = QuantityValue Text Text
  | TextValue Text
  | BooleanValue Bool
  deriving (Eq,Show)

data EvidenceBinding = EvidenceBinding
  { evidenceId :: Text
  , evidenceRole :: Text
  , evidenceInstance :: Text
  , evidenceNativeId :: Text
  , evidenceRevision :: Text
  , evidenceQueryDigest :: Text
  } deriving (Eq,Show)

data ConflictObservation = ConflictObservation
  { conflictValue :: SemanticValue
  , conflictEvidence :: EvidenceBinding
  } deriving (Eq,Show)

data Knowledge
  = Known SemanticValue
  | Unknown Text
  | Conflicting [ConflictObservation]
  deriving (Eq,Show)

data SemanticFact = SemanticFact
  { semanticFactId :: Text
  , semanticSubjectId :: Text
  , semanticPropertyId :: Text
  , semanticKnowledge :: Knowledge
  , semanticEvidence :: [EvidenceBinding]
  } deriving (Eq,Show)

data Constraint
  = RequiresKnown Text Text
  | SameValue Text Text Text
  deriving (Eq,Show)

data ConstraintStatus = Satisfied | Violated | Indeterminate
  deriving (Eq,Show)

data ConstraintReceipt = ConstraintReceipt
  { receiptConstraintId :: Text
  , receiptStatus :: ConstraintStatus
  , receiptReason :: Text
  } deriving (Eq,Show)

data MappingFidelity
  = ProjectionOnly Text
  deriving (Eq,Show)

data MappingReceipt = MappingReceipt
  { semanticMappingId :: Text
  , semanticBindingGrade :: Text
  , semanticUnitPolicy :: Text
  , semanticMappingFidelity :: MappingFidelity
  } deriving (Eq,Show)

data SemanticPackage = SemanticPackage
  { semanticModelId :: Text
  , semanticModelVersion :: Text
  , semanticFacts :: [SemanticFact]
  , semanticConstraints :: [Constraint]
  , semanticReceipts :: [ConstraintReceipt]
  , semanticMapping :: MappingReceipt
  } deriving (Eq,Show)

data SemanticCatalog = SemanticCatalog
  { catalogModelId :: Text
  , catalogModelVersion :: Text
  , catalogFactIds :: [Text]
  , catalogConstraintIds :: [Text]
  , catalogClaimKinds :: [Text]
  , catalogMappingId :: Text
  } deriving (Eq,Show)

data Claim
  = NativeReportedValues
  | SourceCoverageLimit
  | PhysicalProductionOccurred
  | ReportedQuantity Text Text
  deriving (Eq,Show)

data EvidenceClass = NativeERP | NativeMES | OtherEvidence
  deriving (Eq,Show)

data Relation = Supports | Contradicts | Related | Irrelevant
  deriving (Eq,Show)

data ClaimRelation = ClaimRelation
  { claimEvidenceClass :: EvidenceClass
  , claimRelation :: Relation
  , claimRationale :: Text
  } deriving (Eq,Show)

data ClaimAssessment = ClaimAssessment
  { assessedClaimId :: Text
  , assessedClaimText :: Text
  , assessedRelations :: [ClaimRelation]
  } deriving (Eq,Show)

factIds :: [Text]
factIds =
  [ "fact:erp-planned-quantity"
  , "fact:mes-planned-quantity"
  , "fact:erp-reported-quantity"
  , "fact:mes-reported-quantity"
  , "fact:receipt-evidence"
  , "fact:ledger-evidence"
  , "fact:physical-production"
  ]

constraintIds :: [Text]
constraintIds =
  [ "constraint:erp-report-known"
  , "constraint:mes-report-known"
  , "constraint:plan-alignment"
  , "constraint:reported-alignment"
  , "constraint:physical-production-known"
  ]

semanticCatalog :: SemanticCatalog
semanticCatalog = SemanticCatalog
  { catalogModelId = "fde.w1.production-order"
  , catalogModelVersion = "v1"
  , catalogFactIds = factIds
  , catalogConstraintIds = constraintIds
  , catalogClaimKinds =
      [ "native-reported-values"
      , "source-coverage-limit"
      , "physical-production-occurred"
      , "reported-quantity"
      ]
  , catalogMappingId = "fde.w1.synthetic-pcs-Nos/v1"
  }

bindingFor :: Source -> EvidenceBinding
bindingFor s = EvidenceBinding
  { evidenceId = "evidence:" <> role s <> ":" <> queryDigest s
  , evidenceRole = role s
  , evidenceInstance = instanceId s
  , evidenceNativeId = nativeId s
  , evidenceRevision = revision s
  , evidenceQueryDigest = queryDigest s
  }

subject :: CompileInput -> Text
subject input =
  "bounded-order:" <> instanceId (erp input) <> "/" <> nativeId (erp input) <>
  ":" <> instanceId (mes input) <> "/" <> nativeId (mes input)

quantityFact :: Text -> Text -> Source -> Text -> Either Text SemanticFact
quantityFact fid property s raw = do
  normalized <- canonicalQuantity raw
  pure SemanticFact
    { semanticFactId = fid
    , semanticSubjectId = ""
    , semanticPropertyId = property
    , semanticKnowledge = Known (QuantityValue normalized "synthetic-count")
    , semanticEvidence = [bindingFor s]
    }

buildSemanticPackage :: CompileInput -> Either Text SemanticPackage
buildSemanticPackage input = do
  _ <- compile input
  erpPlan <- quantityFact "fact:erp-planned-quantity" "planned-quantity" (erp input) (planned (erp input))
  mesPlan <- quantityFact "fact:mes-planned-quantity" "planned-quantity" (mes input) (planned (mes input))
  erpReport <- quantityFact "fact:erp-reported-quantity" "reported-quantity" (erp input) (reported (erp input))
  mesReport <- quantityFact "fact:mes-reported-quantity" "reported-quantity" (mes input) (reported (mes input))
  let sid = subject input
      withSubject f = f { semanticSubjectId = sid }
      both = [bindingFor (erp input),bindingFor (mes input)]
      unknownFact fid property reason = SemanticFact
        { semanticFactId = fid
        , semanticSubjectId = sid
        , semanticPropertyId = property
        , semanticKnowledge = Unknown reason
        , semanticEvidence = both
        }
      facts =
        [ withSubject erpPlan,withSubject mesPlan,withSubject erpReport,withSubject mesReport
        , unknownFact "fact:receipt-evidence" "receipt-evidence" "not-covered-by-admitted-native-read"
        , unknownFact "fact:ledger-evidence" "ledger-evidence" "not-covered-by-admitted-native-read"
        , unknownFact "fact:physical-production" "physical-production" "not-covered-by-admitted-native-read"
        ]
      constraints =
        [ RequiresKnown "constraint:erp-report-known" "fact:erp-reported-quantity"
        , RequiresKnown "constraint:mes-report-known" "fact:mes-reported-quantity"
        , SameValue "constraint:plan-alignment" "fact:erp-planned-quantity" "fact:mes-planned-quantity"
        , SameValue "constraint:reported-alignment" "fact:erp-reported-quantity" "fact:mes-reported-quantity"
        , RequiresKnown "constraint:physical-production-known" "fact:physical-production"
        ]
      receipts = map (evaluateConstraint facts) constraints
  pure SemanticPackage
    { semanticModelId = catalogModelId semanticCatalog
    , semanticModelVersion = catalogModelVersion semanticCatalog
    , semanticFacts = facts
    , semanticConstraints = constraints
    , semanticReceipts = receipts
    , semanticMapping = MappingReceipt
        { semanticMappingId = catalogMappingId semanticCatalog
        , semanticBindingGrade = mappingGrade (binding input)
        , semanticUnitPolicy = unitPolicy (binding input)
        , semanticMappingFidelity = ProjectionOnly
            "Reviewed synthetic pcs/Nos equivalence is valid only for this bounded comparison; it does not make ERP and MES schemas or physical meanings equivalent."
        }
    }

knowledgeFor :: [SemanticFact] -> Text -> Maybe Knowledge
knowledgeFor facts fid = semanticKnowledge <$> find ((== fid) . semanticFactId) facts

evaluateConstraint :: [SemanticFact] -> Constraint -> ConstraintReceipt
evaluateConstraint facts constraint =
  case constraint of
    RequiresKnown cid fid ->
      case knowledgeFor facts fid of
        Just (Known _) -> receipt cid Satisfied "required-fact-known"
        Just (Unknown _) -> receipt cid Violated "required-fact-unknown"
        Just (Conflicting _) -> receipt cid Indeterminate "required-fact-conflicting"
        Nothing -> receipt cid Indeterminate "required-fact-missing"
    SameValue cid left right ->
      case (knowledgeFor facts left,knowledgeFor facts right) of
        (Just (Known a),Just (Known b))
          | a == b -> receipt cid Satisfied "known-values-equal"
          | otherwise -> receipt cid Violated "known-values-differ"
        (Just (Conflicting _),_) -> receipt cid Indeterminate "conflicting-value"
        (_,Just (Conflicting _)) -> receipt cid Indeterminate "conflicting-value"
        (Nothing,_) -> receipt cid Indeterminate "fact-missing"
        (_,Nothing) -> receipt cid Indeterminate "fact-missing"
        _ -> receipt cid Indeterminate "unknown-value"
  where
    receipt cid status reason = ConstraintReceipt cid status reason

relation :: EvidenceClass -> Relation -> Text -> ClaimRelation
relation = ClaimRelation

otherIrrelevant :: ClaimRelation
otherIrrelevant = relation OtherEvidence Irrelevant
  "Reference/context evidence cannot substitute for the exact native source evidence required by this bounded claim."

assessClaim :: CompileInput -> Claim -> Either Text ClaimAssessment
assessClaim input claim = do
  _ <- buildSemanticPackage input
  case claim of
    NativeReportedValues ->
      pure ClaimAssessment
        { assessedClaimId = "fde:native-reported-values"
        , assessedClaimText =
            "ERPNext reports " <> reported (erp input) <> " " <> unit (erp input) <>
            " in its native reported quantity field and OpenMES reports " <>
            reported (mes input) <> " " <> unit (mes input) <>
            " in its native reported quantity field."
        , assessedRelations =
            [ relation NativeERP Supports "The ERP claim quotes the exact admitted ERP native reported field."
            , relation NativeMES Supports "The MES claim quotes the exact admitted MES native reported field."
            , otherIrrelevant
            ]
        }
    SourceCoverageLimit ->
      pure ClaimAssessment
        { assessedClaimId = "fde:source-coverage-limit"
        , assessedClaimText =
            "The current ERPNext and OpenMES observations cover exact native order rows but do not cover receipt, stock-ledger, or physical-production evidence."
        , assessedRelations =
            [ relation NativeERP Supports "The admitted ERP observation explicitly records receipt, ledger and physical coverage as not-covered."
            , relation NativeMES Supports "The admitted MES observation explicitly records receipt, ledger and physical coverage as not-covered."
            , otherIrrelevant
            ]
        }
    PhysicalProductionOccurred ->
      pure ClaimAssessment
        { assessedClaimId = "fde:physical-production-occurred"
        , assessedClaimText = "Physical production occurred for this order."
        , assessedRelations =
            [ relation NativeERP Related "The ERP row concerns the bounded order, but physical-production evidence is explicitly not covered."
            , relation NativeMES Related "The MES row concerns the bounded order, but MES DONE/reported quantity is not physical-production evidence."
            , otherIrrelevant
            ]
        }
    ReportedQuantity wantedRole expected
      | wantedRole /= "erp" && wantedRole /= "mes" -> Left "unsupported-claim-role"
      | otherwise -> do
          expectedQuantity <- canonicalQuantity expected
          let src = if wantedRole == "erp" then erp input else mes input
          actualQuantity <- canonicalQuantity (reported src)
          let nativeClass = if wantedRole == "erp" then NativeERP else NativeMES
              otherNative = if wantedRole == "erp" then NativeMES else NativeERP
              verdict = if expectedQuantity == actualQuantity then Supports else Contradicts
              why = if verdict == Supports
                then "The expected reported quantity equals the exact admitted source-native reported field under the reviewed bounded unit policy."
                else "The expected reported quantity differs from the exact admitted source-native reported field under the reviewed bounded unit policy."
          pure ClaimAssessment
            { assessedClaimId = "fde:reported-quantity:" <> wantedRole
            , assessedClaimText =
                (if wantedRole == "erp" then "ERPNext" else "OpenMES") <>
                " reports " <> expected <> " in its native reported quantity field."
            , assessedRelations =
                [ relation nativeClass verdict why
                , relation otherNative Irrelevant "The other native system does not own this source-specific reported-field claim."
                , otherIrrelevant
                ]
            }
