# Dove sono finiti i test del backend

Fino al 23/09 i test di ogni app stavano in `tests.py` e in file intitolati
alla caccia ai bug del 22/09 (`tests_caccia22_telefono.py`,
`tests_caccia22_undo.py`, …). Col refactoring del 24/09 ogni app ha la
cartella `tests/`: `base.py` con le basi e gli aiuti comuni e un
`test_<argomento>.py` per argomento; gli aiuti fra app stanno in
`backend/common/testing/`.

I rapporti delle cacce ai bug citano ancora i nomi vecchi: questa tabella dice
dove è finita ogni classe. Classi e metodi hanno gli stessi nomi di prima e
nessuna classe è stata divisa: con il nome della classe si trova il test anche
con una ricerca nel codice. I percorsi sono relativi a `backend/`.

## apps/accounts/tests.py
- ClientIpTests → apps/accounts/tests/test_security.py
- ClientOTPFlowTests → apps/accounts/tests/test_client_auth.py
- ClientOTPSecurityTests → apps/accounts/tests/test_client_auth.py
- ClientRegisterRateLimitTests → apps/accounts/tests/test_client_auth.py
- DefaultRolesTests → apps/accounts/tests/test_team.py
- InvitationPasswordTests → apps/accounts/tests/test_team.py
- MediaGuardTests → apps/accounts/tests/test_security.py
- StaffAuthTests → apps/accounts/tests/test_staff_auth.py
- StaffLoginThrottleTests → apps/accounts/tests/test_staff_auth.py
- StaffSessionTests → apps/accounts/tests/test_staff_auth.py
- StreamPermissionTests → apps/accounts/tests/test_security.py
- TeamPrivilegeTests → apps/accounts/tests/test_team.py

## apps/accounts/tests_caccia22_accesso.py
- ArchivedClientAccessTests → apps/accounts/tests/test_client_auth.py
- ClientProfileTests → apps/accounts/tests/test_client_auth.py
- LegacyRefreshTests → apps/accounts/tests/test_staff_auth.py
- OtpSalonCapTests → apps/accounts/tests/test_client_auth.py
- PasswordChangeThrottleTests → apps/accounts/tests/test_staff_auth.py
- RegisterDoubleSubmitTests → apps/accounts/tests/test_client_auth.py
- RegisterSalonCapTests → apps/accounts/tests/test_client_auth.py
- StaffLoginChoiceTests → apps/accounts/tests/test_staff_auth.py

## apps/accounts/tests_caccia22_ruoli_inviti.py
- InvitationSingleUseTests → apps/accounts/tests/test_team.py
- InvitationTokenTests → apps/accounts/tests/test_team.py
- MemberRoleChangeTests → apps/accounts/tests/test_team.py
- SystemRoleTests → apps/accounts/tests/test_team.py

## apps/agenda/tests.py
- AgendaDayLocationTests → apps/agenda/tests/test_views.py
- AppointmentEditApiTests → apps/agenda/tests/test_edit.py
- AutomationDelayTests → apps/agenda/tests/test_messages.py
- AvailabilityMatchesBookingTests → apps/agenda/tests/test_availability.py
- BugHunt21SeptemberTests → apps/agenda/tests/test_move_split.py
- BugHuntAgendaTests → apps/agenda/tests/test_availability.py
- CancelAppointmentTests → apps/agenda/tests/test_lifecycle.py
- ClientBookingApiTests → apps/agenda/tests/test_booking.py
- ClientOverlapTests → apps/agenda/tests/test_booking.py
- ClosingTimeOnEveryPathTests → apps/agenda/tests/test_soak.py
- ComputeDepositTests → apps/agenda/tests/test_deposit.py
- ConcurrentTransitionTests → apps/agenda/tests/test_lifecycle.py
- CreateAppointmentTests → apps/agenda/tests/test_booking.py
- DaylightSavingTests → apps/agenda/tests/test_availability.py
- DeactivatedOperatorTests → apps/agenda/tests/test_move_split.py
- DepositFitsTheVisitTests → apps/agenda/tests/test_deposit.py
- DepositHoldTests → apps/agenda/tests/test_deposit.py
- ForcedBookingTests → apps/agenda/tests/test_booking.py
- GetFreeSlotsTests → apps/agenda/tests/test_availability.py
- MidnightPauseTests → apps/agenda/tests/test_availability.py
- MoveWholeVisitToAnotherOperatorTests → apps/agenda/tests/test_move_split.py
- OpeningHoursAvailabilityTests → apps/agenda/tests/test_availability.py
- PublicAvailabilityApiTests → apps/agenda/tests/test_availability.py
- PublicAvailabilityContentTests → apps/agenda/tests/test_availability.py
- RangeAndGiftTests → apps/agenda/tests/test_views.py
- ReadEndpointsTests → apps/agenda/tests/test_views.py
- RealShiftWindowsTests → apps/agenda/tests/test_availability.py
- RefundConcurrencyTests → apps/agenda/tests/test_deposit.py
- RequestValidationTests → apps/agenda/tests/test_booking.py
- RestoreReleasedTests → apps/agenda/tests/test_deposit.py
- SlotIntervalTests → apps/agenda/tests/test_availability.py
- SmartSlotMultiOperatorTests → apps/agenda/tests/test_availability.py
- SmartSlotsTests → apps/agenda/tests/test_availability.py
- SoakTimeTests → apps/agenda/tests/test_soak.py
- SplitAppointmentTests → apps/agenda/tests/test_move_split.py
- SplitCollisionTests → apps/agenda/tests/test_move_split.py
- StaleCopyEditTests → apps/agenda/tests/test_edit.py
- UndoTests → apps/agenda/tests/test_undo.py
- WaitlistTests → apps/agenda/tests/test_waitlist.py

## apps/agenda/tests_caccia22_api.py
- ClientResponsesTests → apps/agenda/tests/test_booking.py
- DayColumnsTests → apps/agenda/tests/test_views.py
- DepositForPastStartTests → apps/agenda/tests/test_deposit.py
- DepositNetOfGiftCardsTests → apps/agenda/tests/test_deposit.py
- GiftCodesInTheAgendaTests → apps/agenda/tests/test_views.py
- GiftFromNameTests → apps/agenda/tests/test_views.py
- InvalidDatesTests → apps/agenda/tests/test_booking.py
- ReleasedScopeTests → apps/agenda/tests/test_deposit.py
- StaffRecordsClientCancellationTests → apps/agenda/tests/test_lifecycle.py

## apps/agenda/tests_caccia22_caparra.py
- DepositHoldFollowsTheVisitTests → apps/agenda/tests/test_deposit.py
- PaidDepositOnAShorterVisitTests → apps/agenda/tests/test_deposit.py
- RefundEventsOrderTests → apps/agenda/tests/test_deposit.py

## apps/agenda/tests_caccia22_ciclo.py
- CheckInNeverGoesBackwardsTests → apps/agenda/tests/test_lifecycle.py
- ClientMoveNeverLandsInAnotherSoakTests → apps/agenda/tests/test_soak.py
- LockOrderTests → apps/agenda/tests/test_lifecycle.py
- NoShowOnlyForAConfirmedStartedVisitTests → apps/agenda/tests/test_lifecycle.py

## apps/agenda/tests_caccia22_disponibilita.py
- ClientMoveOperatorLeftTests → apps/agenda/tests/test_move_split.py
- ClientNeverIntoForeignSoakTests → apps/agenda/tests/test_soak.py
- ForcedFirstAvailableTests → apps/agenda/tests/test_availability.py
- MoveAfterLostSkillTests → apps/agenda/tests/test_move_split.py
- NewBookingUnbookableOperatorTests → apps/agenda/tests/test_availability.py
- RecommendedWithSoakTests → apps/agenda/tests/test_availability.py
- SameClientAssignmentTests → apps/agenda/tests/test_availability.py
- SoakInsideTheOpeningBandTests → apps/agenda/tests/test_soak.py
- StaffRescheduleTests → apps/agenda/tests/test_move_split.py

## apps/agenda/tests_caccia22_messaggi.py
- CancelClosesTheDepositLinkTests → apps/agenda/tests/test_messages.py
- ClientWhoKnowsIsAlwaysToldTests → apps/agenda/tests/test_messages.py
- DelaySwitchedOffTests → apps/agenda/tests/test_messages.py
- FreedSlotSaysWhatReallyFreedUpTests → apps/agenda/tests/test_messages.py
- LateJoinerOfTheWaitlistTests → apps/agenda/tests/test_waitlist.py
- MergedMoveKeepsWhatTheClientKnowsTests → apps/agenda/tests/test_messages.py
- PayloadCarriesThePreferencesTests → apps/agenda/tests/test_messages.py
- ReleaseForUnpaidDepositTests → apps/agenda/tests/test_messages.py
- UndoNeverSilencesAChangeInForceTests → apps/agenda/tests/test_undo.py

## apps/agenda/tests_caccia22_modifica.py
- DurationBoundsTests → apps/agenda/tests/test_edit.py
- EditNextToTheSameClientTests → apps/agenda/tests/test_edit.py
- ExistingRowKeepsItsOperatorTests → apps/agenda/tests/test_edit.py
- NoEligibleOperatorTests → apps/agenda/tests/test_edit.py
- ReassignFromInactiveColumnTests → apps/agenda/tests/test_edit.py
- StaleCopyTests → apps/agenda/tests/test_edit.py

## apps/agenda/tests_caccia22_undo.py
- UndoOfABookingWithADepositLinkTests → apps/agenda/tests/test_undo.py
- UndoOfACancellationSendsANewLinkTests → apps/agenda/tests/test_undo.py
- UndoRechecksTheSlotTests → apps/agenda/tests/test_undo.py
- UndoRefusedWhenMoneyMovedTests → apps/agenda/tests/test_undo.py
- UndoRestoresTheSameRowsTests → apps/agenda/tests/test_undo.py
- UndoTellsTheRealReasonTests → apps/agenda/tests/test_undo.py

## apps/automations/tests.py
- AutomationsApiTests → apps/automations/tests/test_automations_api.py
- AutomationsReadableWithoutMarketingTests → apps/automations/tests/test_automations_api.py

## apps/automations/tests_caccia22_toggle.py
- StaleCopyTests → apps/automations/tests/test_automations_api.py

## apps/catalog/tests.py
- CatalogHttpSmokeTests → apps/catalog/tests/test_categories.py
- CategoryColorTests → apps/catalog/tests/test_categories.py
- CategoryValidationTests → apps/catalog/tests/test_categories.py
- PackageItemsPreservedTests → apps/catalog/tests/test_services_packages.py
- PackageUpdateAtomicityTests → apps/catalog/tests/test_services_packages.py
- PackageWithItemsTests → apps/catalog/tests/test_services_packages.py
- PublicEndpointsTests → apps/catalog/tests/test_public_catalog.py
- ReorderCategoriesTests → apps/catalog/tests/test_categories.py
- ServiceDescriptionTests → apps/catalog/tests/test_services_packages.py
- ServicePriceChangeLogTests → apps/catalog/tests/test_services_packages.py
- ServiceSoakMinTests → apps/catalog/tests/test_services_packages.py

## apps/catalog/tests_caccia22_catalogo.py
- PublicSoakTests → apps/catalog/tests/test_public_catalog.py
- YourangLinkSurvivesEditsTests → apps/catalog/tests/test_services_packages.py

## apps/clients/tests.py
- CategoryTests → apps/clients/tests/test_labels.py
- ClientAppointmentsApiTests → apps/clients/tests/test_history_stats.py
- ClientCrudTests → apps/clients/tests/test_client_card.py
- ClientFactsTests → apps/clients/tests/test_history_stats.py
- ClientGenderBirthdayApiTests → apps/clients/tests/test_client_card.py
- ClientHistoryApiTests → apps/clients/tests/test_history_stats.py
- ClientHistoryQueryCountTests → apps/clients/tests/test_history_stats.py
- ClientListTests → apps/clients/tests/test_search.py
- ClientPartialUpdateTests → apps/clients/tests/test_client_card.py
- ClientStatsOnRealSalesTests → apps/clients/tests/test_history_stats.py
- ImportFlexibleTests → apps/clients/tests/test_import.py
- ImportRobustnessTests → apps/clients/tests/test_import.py
- ImportUpsertTests → apps/clients/tests/test_import.py
- InputValidationApiTests → apps/clients/tests/test_client_card.py
- NoteAttachmentsApiTests → apps/clients/tests/test_notes_sheets.py
- NotesTests → apps/clients/tests/test_notes_sheets.py
- PhoneLookupTests → apps/clients/tests/test_search.py
- PhoneNormalizationTests → apps/clients/tests/test_phone.py
- PublicHookTests → apps/clients/tests/test_public_hook.py
- SalesFiguresNeedTheSalesScopeTests → apps/clients/tests/test_history_stats.py
- SensitiveReadsNeedTheClientsScopeTests → apps/clients/tests/test_history_stats.py
- TechnicalSheetTests → apps/clients/tests/test_notes_sheets.py

## apps/clients/tests_caccia22_etichette.py
- DeleteLabelTests → apps/clients/tests/test_labels.py
- DuplicateLabelTests → apps/clients/tests/test_labels.py
- RenameLabelTests → apps/clients/tests/test_labels.py

## apps/clients/tests_caccia22_form.py
- ArchivedCardTests → apps/clients/tests/test_public_hook.py
- ExistingCardTests → apps/clients/tests/test_public_hook.py
- LeadLanguageTests → apps/clients/tests/test_public_hook.py

## apps/clients/tests_caccia22_import.py
- ArchivedCardTests → apps/clients/tests/test_import.py
- BirthdayTests → apps/clients/tests/test_import.py
- ImplausiblePhoneTests → apps/clients/tests/test_import.py
- ImportApiTests → apps/clients/tests/test_import.py
- ReimportTests → apps/clients/tests/test_import.py
- SharedEmailTests → apps/clients/tests/test_import.py
- SinceTests → apps/clients/tests/test_import.py

## apps/clients/tests_caccia22_ricerca.py
- AccentInsensitiveSearchTests → apps/clients/tests/test_search.py

## apps/clients/tests_caccia22_scheda.py
- ArchivedPhoneTests → apps/clients/tests/test_client_card.py
- ConsentDatesTests → apps/clients/tests/test_client_card.py
- GiftCodesOnTheCardTests → apps/clients/tests/test_client_card.py
- MarketingFollowsTheCardTests → apps/clients/tests/test_client_card.py
- OnlyChangedColumnsTests → apps/clients/tests/test_client_card.py
- PartialPutOverHttpTests → apps/clients/tests/test_client_card.py

## apps/clients/tests_caccia22_schede_tecniche.py
- SheetPhotoUrlTests → apps/clients/tests/test_notes_sheets.py

## apps/clients/tests_caccia22_statistiche.py
- DepositAndNoShowAreNotVisitsTests → apps/clients/tests/test_history_stats.py
- HistoryDepositTests → apps/clients/tests/test_history_stats.py
- HistorySalesHiddenTests → apps/clients/tests/test_history_stats.py

## apps/clients/tests_caccia22_telefono.py
- CheckPhoneDuplicatesTests → apps/clients/tests/test_phone.py
- PhoneKeyMigrationTests → apps/clients/tests/test_phone.py
- PhoneRulesTableTests → apps/clients/tests/test_phone.py

## apps/core/tests.py
- ActivityFeedApiTests → apps/core/tests/test_activity.py
- ActivityStreamTests → apps/core/tests/test_activity.py
- CoreTests → apps/core/tests/test_activity.py
- FlushOutboxTests → apps/core/tests/test_outbox.py
- LocationDefaultTests → apps/core/tests/test_settings.py
- LogoApiTests → apps/core/tests/test_settings.py
- OutboxStatusApiTests → apps/core/tests/test_outbox.py
- PublicBrandingApiTests → apps/core/tests/test_settings.py
- RateLimitCounterTests → apps/core/tests/test_rate_limit.py
- SettingsApiTests → apps/core/tests/test_settings.py
- SettingsAuditExtrasTests → apps/core/tests/test_settings.py
- StreamConnectionCapTests → apps/core/tests/test_activity.py

## apps/core/tests_caccia22_create_salon.py
- CreateSalonOwnerTests → apps/core/tests/test_commands.py
- CreateSalonSlugTests → apps/core/tests/test_commands.py

## apps/core/tests_caccia22_impostazioni.py
- ActivityLogDatesTests → apps/core/tests/test_activity.py
- AdminOpeningHoursTests → apps/core/tests/test_settings.py
- DepositRuleAmountTests → apps/core/tests/test_settings.py
- SettingsSavedByFieldTests → apps/core/tests/test_settings.py

## apps/core/tests_caccia22_live.py
- KeepaliveTests → apps/core/tests/test_activity.py
- LateCommitTests → apps/core/tests/test_activity.py
- StreamTicketTests → apps/core/tests/test_activity.py

## apps/core/tests_caccia22_outbox.py
- ClaimRereadsTheEventTests → apps/core/tests/test_outbox.py
- ColumnsAddedBy0009HaveADatabaseDefaultTests → apps/core/tests/test_outbox.py
- DeliveryOrderPerObjectTests → apps/core/tests/test_outbox.py
- DueAtTests → apps/core/tests/test_outbox.py
- HeldEventsDoNotBlockTests → apps/core/tests/test_outbox.py
- HousekeepingWithoutDeliveryUrlTests → apps/core/tests/test_outbox.py
- LastDeliveredMessageSurvivesThePurgeTests → apps/core/tests/test_outbox.py
- OpeningHoursNotSetTests → apps/core/tests/test_settings.py
- StaleMessagesExpireTests → apps/core/tests/test_outbox.py
- UndoEntriesArePurgedTests → apps/core/tests/test_outbox.py

## apps/core/tests_caccia22_seed_demo.py
- SeedDemoAccountTests → apps/core/tests/test_commands.py
- SeedDemoOutsideDebugTests → apps/core/tests/test_commands.py
- SeedDemoResetTests → apps/core/tests/test_commands.py

## apps/insights/tests.py
- ClientsByCategoryTests → apps/insights/tests/test_kpis.py
- CustomRangeTests → apps/insights/tests/test_periods.py
- DepositIsNotCountedTwiceTests → apps/insights/tests/test_kpis.py
- KpisMinimalDatasetTests → apps/insights/tests/test_kpis.py
- NewClientsTests → apps/insights/tests/test_kpis.py
- OccupancyAfterStaffChangesTests → apps/insights/tests/test_occupancy.py
- OccupancyStatusTests → apps/insights/tests/test_occupancy.py
- PeriodRangeTests → apps/insights/tests/test_periods.py
- RebookingRateTests → apps/insights/tests/test_kpis.py
- ShiftCapacityQueryBudgetTests → apps/insights/tests/test_occupancy.py

## apps/insights/tests_caccia22_insights.py
- ClosedWeekdaysTests → apps/insights/tests/test_occupancy.py
- ImpossibleDatesTests → apps/insights/tests/test_periods.py
- InsightsScopeTests → apps/insights/tests/test_kpis.py
- NewClientsAreRealNewCustomersTests → apps/insights/tests/test_kpis.py
- RatesOnElapsedAppointmentsTests → apps/insights/tests/test_kpis.py
- RebookingOfPastPeriodsTests → apps/insights/tests/test_kpis.py

## apps/integrations/tests.py
- CancelEventGuardTests → apps/integrations/tests/test_events.py
- ClientRequestTests → apps/integrations/tests/test_client.py
- ContactPushTests → apps/integrations/tests/test_sync.py
- CronRecoveryTests → apps/integrations/tests/test_sync.py
- CryptoRoundTripTests → apps/integrations/tests/test_crypto.py
- DisconnectTests → apps/integrations/tests/test_oauth.py
- ImportEventIdempotencyTests → apps/integrations/tests/test_events.py
- LoginIdentityTests → apps/integrations/tests/test_oauth.py
- OrgUniquenessTests → apps/integrations/tests/test_oauth.py
- PhoneTests → apps/integrations/tests/test_phone.py
- SignatureTests → apps/integrations/tests/test_crypto.py
- WebhookRouteTests → apps/integrations/tests/test_webhook.py

## apps/integrations/tests_caccia22_collegamento.py
- ConcurrentFirstLoginTests → apps/integrations/tests/test_oauth.py
- ConnectStateTests → apps/integrations/tests/test_oauth.py
- CronLastErrorTests → apps/integrations/tests/test_sync.py
- InitialSyncTests → apps/integrations/tests/test_sync.py
- LoginAdoptionTests → apps/integrations/tests/test_oauth.py
- OrgChangeTests → apps/integrations/tests/test_oauth.py
- StatusLastErrorTests → apps/integrations/tests/test_oauth.py

## apps/integrations/tests_caccia22_eventi.py
- ConcurrentDeliveryTests → apps/integrations/tests/test_events.py
- ItemRowRepairTests → apps/integrations/tests/test_events.py
- LiveFeedTests → apps/integrations/tests/test_events.py
- PhonelessTests → apps/integrations/tests/test_events.py
- PlaceholderEligibilityTests → apps/integrations/tests/test_events.py
- PlaceholderReassignOverHttpTests → apps/integrations/tests/test_events.py
- RedeliveryTests → apps/integrations/tests/test_events.py
- RemoteCancelTests → apps/integrations/tests/test_events.py
- RemoteStatusTests → apps/integrations/tests/test_events.py
- SyncedContactSinceTests → apps/integrations/tests/test_events.py

## apps/integrations/tests_caccia22_webhook.py
- CatalogueRaceTests → apps/integrations/tests/test_sync.py
- ContactWebhookTests → apps/integrations/tests/test_webhook.py
- PooledClientTests → apps/integrations/tests/test_sync.py

## apps/inventory/tests.py
- CategoryValidationTests → apps/inventory/tests/test_products_api.py
- DraftOrderThresholdTests → apps/inventory/tests/test_orders.py
- InventoryApiTests → apps/inventory/tests/test_products_api.py
- InventoryHttpSmokeTests → apps/inventory/tests/test_products_api.py
- InventoryTests → apps/inventory/tests/test_stock.py
- InvoiceUploadValidationTests → apps/inventory/tests/test_loads_invoices.py
- InvoiceUrlTests → apps/inventory/tests/test_loads_invoices.py
- OrderWorkflowTests → apps/inventory/tests/test_orders.py
- ProductCrudTests → apps/inventory/tests/test_products_api.py
- ProductDeletionProtectsHistoryTests → apps/inventory/tests/test_stock.py
- ReceiveOrderConcurrencyTests → apps/inventory/tests/test_orders.py

## apps/inventory/tests_caccia22_magazzino.py
- DeactivatedProductsTests → apps/inventory/tests/test_products_api.py
- InvoiceUploadTests → apps/inventory/tests/test_loads_invoices.py
- LoadCsvMatchingTests → apps/inventory/tests/test_loads_invoices.py
- LoadCsvRowIsolationTests → apps/inventory/tests/test_loads_invoices.py
- StableOrderingTests → apps/inventory/tests/test_products_api.py
- StockSoldEventTests → apps/inventory/tests/test_stock.py

## apps/marketing/tests.py
- ClientGiftCardLimitsTests → apps/marketing/tests/test_gift_cards.py
- ClientIdFilterApiTests → apps/marketing/tests/test_coupons.py
- ClientWalletTests → apps/marketing/tests/test_gift_cards.py
- CommunicationScheduleTests → apps/marketing/tests/test_communications.py
- CommunicationTests → apps/marketing/tests/test_communications.py
- CouponApiTests → apps/marketing/tests/test_coupons.py
- CouponTests → apps/marketing/tests/test_coupons.py
- GiftCardCashInTests → apps/marketing/tests/test_gift_cards.py
- GiftCardFlowTests → apps/marketing/tests/test_gift_cards.py
- GiftCardServiceApiTests → apps/marketing/tests/test_gift_cards.py
- GiftCardTests → apps/marketing/tests/test_gift_cards.py
- LoyaltyConcurrencyTests → apps/marketing/tests/test_loyalty.py
- LoyaltyProgramValidationTests → apps/marketing/tests/test_loyalty.py
- LoyaltyRewardIssueTests → apps/marketing/tests/test_loyalty.py
- LoyaltyTests → apps/marketing/tests/test_loyalty.py
- MarketingConsentTests → apps/marketing/tests/test_communications.py

## apps/marketing/tests_caccia22_comunicazioni.py
- AlreadyDeliveredTests → apps/marketing/tests/test_communications.py
- HeldUntilTheDateTests → apps/marketing/tests/test_communications.py
- LegacyDeliveriesMigrationTests → apps/marketing/tests/test_communications.py
- NoScheduleInThePastTests → apps/marketing/tests/test_communications.py
- PastScheduleBecomesSentTests → apps/marketing/tests/test_communications.py
- RevocationAfterSchedulingTests → apps/marketing/tests/test_communications.py
- UpdateWritesOnlyItsFieldsTests → apps/marketing/tests/test_communications.py

## apps/marketing/tests_caccia22_fedelta.py
- AccountsPagingTests → apps/marketing/tests/test_loyalty.py
- AccrueWithoutSaleLinesTests → apps/marketing/tests/test_loyalty.py
- FreeServiceZeroPriceTests → apps/marketing/tests/test_loyalty.py
- GiftCardOnlySaleTests → apps/marketing/tests/test_loyalty.py
- RewardSpentTests → apps/marketing/tests/test_loyalty.py
- StaffEnrollmentTests → apps/marketing/tests/test_loyalty.py
- StampsMigrationTests → apps/marketing/tests/test_loyalty.py
- StampsProgramTests → apps/marketing/tests/test_loyalty.py

## apps/marketing/tests_caccia22_giftcard.py
- CodeMaskingTests → apps/marketing/tests/test_gift_cards.py
- CouponUpdateRaceTests → apps/marketing/tests/test_coupons.py
- ExpiredListsTests → apps/marketing/tests/test_gift_cards.py
- FrontDeskCashTests → apps/marketing/tests/test_gift_cards.py
- WalletSpendableTests → apps/marketing/tests/test_gift_cards.py

## apps/sales/tests.py
- BugHunt21SeptemberTests → apps/sales/tests/test_checkout.py
- BugHuntRegressionTests → apps/sales/tests/test_sales.py
- ChargeNoShowTests → apps/sales/tests/test_no_show.py
- CheckoutApiTests → apps/sales/tests/test_checkout.py
- CouponAtTheTillTests → apps/sales/tests/test_coupons.py
- DepositIsCashOfItsOwnDayTests → apps/sales/tests/test_checkout.py
- DepositLinkAndConnectTests → apps/sales/tests/test_deposit_link.py
- DepositRefundStateTests → apps/sales/tests/test_refunds.py
- DuplicateDepositPaymentTests → apps/sales/tests/test_stripe_webhook.py
- FinalizeSaleTests → apps/sales/tests/test_sales.py
- GiftCardQuantityTests → apps/sales/tests/test_sales.py
- ListSalesApiTests → apps/sales/tests/test_sales.py
- NoShowAmountTests → apps/sales/tests/test_no_show.py
- PosApiValidationTests → apps/sales/tests/test_sales.py
- SaleAmountValidationTests → apps/sales/tests/test_sales.py
- StripeWebhookTests → apps/sales/tests/test_stripe_webhook.py
- TenantIsolationTests → apps/sales/tests/test_sales.py
- TodaySummaryTests → apps/sales/tests/test_sales.py

## apps/sales/tests_caccia22_link.py
- AmountChangeTests → apps/sales/tests/test_deposit_link.py
- DepositAccountTests → apps/sales/tests/test_deposit_link.py
- HoldWithoutLinkTests → apps/sales/tests/test_deposit_link.py
- LinkLifetimeTests → apps/sales/tests/test_deposit_link.py
- OrphanPaymentTests → apps/sales/tests/test_stripe_webhook.py

## apps/sales/tests_caccia22_lock.py
- LockOrderTests → apps/sales/tests/test_locking.py
- OneStripeCustomerTests → apps/sales/tests/test_locking.py

## apps/sales/tests_caccia22_rimborsi.py
- RefundLeavesTheTillTests → apps/sales/tests/test_refunds.py

## apps/sales/tests_caccia22_storico.py
- CheckoutSeenByTheAgendaTests → apps/sales/tests/test_checkout.py
- CouponOnTheLinesTests → apps/sales/tests/test_coupons.py
- DepositCoversTheWholeBillTests → apps/sales/tests/test_checkout.py
- HistoryWithoutDepositsTests → apps/sales/tests/test_checkout.py
- ServiceNameOnTheLinesTests → apps/sales/tests/test_checkout.py

## apps/sales/tests_caccia22_stripe.py
- ClientAppOriginTests → apps/sales/tests/test_deposit_link.py
- StripeObjectsAreNotDictsTests → apps/sales/tests/test_stripe_library.py
- WebhookSecretsTests → apps/sales/tests/test_stripe_webhook.py

## apps/staff/tests.py
- CycleWeeksReductionTests → apps/staff/tests/test_shifts.py
- OpeningHoursIntersectionTests → apps/staff/tests/test_shifts.py
- OperatorColorApiTests → apps/staff/tests/test_operators_api.py
- OperatorListQueryCountTests → apps/staff/tests/test_operators_api.py
- OperatorValidationTests → apps/staff/tests/test_operators_api.py
- PerformanceSeriesTests → apps/staff/tests/test_performance.py
- PublicOperatorsApiTests → apps/staff/tests/test_operators_api.py
- ReplaceShiftsValidationTests → apps/staff/tests/test_shifts.py
- ShiftCycleAndContiguityTests → apps/staff/tests/test_shifts.py
- ShiftWindowsTests → apps/staff/tests/test_shifts.py

## apps/staff/tests_caccia22_staff.py
- CashDataVisibilityTests → apps/staff/tests/test_performance.py
- InactiveOperatorsTests → apps/staff/tests/test_operators_api.py
- PartialOperatorUpdateTests → apps/staff/tests/test_operators_api.py
- PublicOperatorsLocationTests → apps/staff/tests/test_operators_api.py
- ReplaceShiftsTests → apps/staff/tests/test_shifts.py
- SecondaryOperatorTests → apps/staff/tests/test_performance.py
