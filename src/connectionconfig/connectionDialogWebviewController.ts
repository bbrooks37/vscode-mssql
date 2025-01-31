/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";

import {
    ActivityStatus,
    ActivityObject,
    TelemetryActions,
    TelemetryViews,
} from "../sharedInterfaces/telemetry";
import {
    AuthenticationType,
    AzureSubscriptionInfo,
    ConnectionDialogFormItemSpec,
    ConnectionDialogReducers,
    ConnectionDialogWebviewState,
    ConnectionInputMode,
    AddFirewallRuleDialogProps,
    IConnectionDialogProfile,
    TrustServerCertDialogProps,
    ConnectionComponentsInfo,
    ConnectionComponentGroup,
} from "../sharedInterfaces/connectionDialog";
import {
    CapabilitiesResult,
    ConnectionCompleteParams,
    GetCapabilitiesRequest,
} from "../models/contracts/connection";
import {
    FormItemActionButton,
    FormItemOptions,
    FormItemSpec,
    FormItemType,
} from "../reactviews/common/forms/form";
import {
    ConnectionDialog as Loc,
    Common as LocCommon,
    refreshTokenLabel,
} from "../constants/locConstants";
import {
    azureSubscriptionFilterConfigKey,
    confirmVscodeAzureSignin,
    fetchServersFromAzure,
    promptForAzureSubscriptionFilter,
} from "./azureHelper";
import {
    sendActionEvent,
    sendErrorEvent,
    startActivity,
} from "../telemetry/telemetry";

import { ApiStatus } from "../sharedInterfaces/webview";
import { AzureController } from "../azure/azureController";
import { AzureSubscription } from "@microsoft/vscode-azext-azureauth";
import { IConnectionInfo, ConnectionOption } from "vscode-mssql";
import { Logger } from "../models/logger";
import MainController from "../controllers/mainController";
import { ObjectExplorerProvider } from "../objectExplorer/objectExplorerProvider";
import { ReactWebviewPanelController } from "../controllers/reactWebviewPanelController";
import { UserSurvey } from "../nps/userSurvey";
import VscodeWrapper from "../controllers/vscodeWrapper";
import {
    connectionCertValidationFailedErrorCode,
    connectionFirewallErrorCode,
} from "./connectionConstants";
import { getConnectionDisplayName } from "../models/connectionInfo";
import { getErrorMessage } from "../utils/utils";
import { l10n } from "vscode";
import {
    CredentialsQuickPickItemType,
    IConnectionCredentialsQuickPickItem,
    IConnectionProfile,
} from "../models/interfaces";
import { IAccount, ITenant } from "../models/contracts/azure";

export class ConnectionDialogWebviewController extends ReactWebviewPanelController<
    ConnectionDialogWebviewState,
    ConnectionDialogReducers
> {
    private _connectionToEditCopy: IConnectionDialogProfile | undefined;

    private static _logger: Logger;
    private _azureSubscriptions: Map<string, AzureSubscription>;

    constructor(
        context: vscode.ExtensionContext,
        private _mainController: MainController,
        private _objectExplorerProvider: ObjectExplorerProvider,
        private _connectionToEdit?: IConnectionInfo,
    ) {
        super(
            context,
            "connectionDialog",
            new ConnectionDialogWebviewState({
                connectionProfile: {} as IConnectionDialogProfile,
                savedConnections: [],
                recentConnections: [],
                selectedInputMode: ConnectionInputMode.Parameters,
                connectionComponents: {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    components: {} as any, // force empty record for intial blank state
                    mainOptions: [],
                    topAdvancedOptions: [],
                    groupedAdvancedOptions: [],
                },
                azureSubscriptions: [],
                azureServers: [],
                connectionStatus: ApiStatus.NotStarted,
                formError: "",
                loadingAzureSubscriptionsStatus: ApiStatus.NotStarted,
                loadingAzureServersStatus: ApiStatus.NotStarted,
                dialog: undefined,
            }),
            {
                title: Loc.connectionDialog,
                viewColumn: vscode.ViewColumn.Active,
                iconPath: {
                    dark: vscode.Uri.joinPath(
                        context.extensionUri,
                        "media",
                        "connectionDialogEditor_dark.svg",
                    ),
                    light: vscode.Uri.joinPath(
                        context.extensionUri,
                        "media",
                        "connectionDialogEditor_light.svg",
                    ),
                },
            },
        );

        if (!ConnectionDialogWebviewController._logger) {
            const vscodeWrapper = new VscodeWrapper();
            const channel = vscodeWrapper.createOutputChannel(
                Loc.connectionDialog,
            );
            ConnectionDialogWebviewController._logger = Logger.create(channel);
        }

        this.registerRpcHandlers();
        this.initializeDialog().catch((err) => {
            void vscode.window.showErrorMessage(getErrorMessage(err));

            // The spots in initializeDialog() that handle potential PII have their own error catches that emit error telemetry with `includeErrorMessage` set to false.
            // Everything else during initialization shouldn't have PII, so it's okay to include the error message here.
            sendErrorEvent(
                TelemetryViews.ConnectionDialog,
                TelemetryActions.Initialize,
                err,
                true, // includeErrorMessage
            );
        });
    }

    private async initializeDialog() {
        try {
            await this.updateLoadedConnections(this.state);
            this.updateState();
        } catch (err) {
            void vscode.window.showErrorMessage(getErrorMessage(err));
            sendErrorEvent(
                TelemetryViews.ConnectionDialog,
                TelemetryActions.Initialize,
                err,
                false, // includeErrorMessage
            );
        }

        try {
            if (this._connectionToEdit) {
                await this.loadConnectionToEdit();
            } else {
                await this.loadEmptyConnection();
            }
        } catch (err) {
            await this.loadEmptyConnection();
            void vscode.window.showErrorMessage(getErrorMessage(err));

            sendErrorEvent(
                TelemetryViews.ConnectionDialog,
                TelemetryActions.Initialize,
                err,
                false, // includeErrorMessage
            );
        }

        this.state.connectionComponents = {
            components: await this.generateConnectionComponents(),
            mainOptions: [
                "server",
                "trustServerCertificate",
                "authenticationType",
                "user",
                "password",
                "savePassword",
                "accountId",
                "tenantId",
                "database",
                "encrypt",
            ],
            topAdvancedOptions: [
                "port",
                "applicationName",
                // TODO: 'autoDisconnect',
                // TODO: 'sslConfiguration',
                "connectTimeout",
                "multiSubnetFailover",
            ],
            groupedAdvancedOptions: [], // computed below
        };

        this.state.connectionComponents.groupedAdvancedOptions =
            this.groupAdvancedOptions(this.state.connectionComponents);

        await this.updateItemVisibility();
        this.updateState();
    }

    private async loadConnectionToEdit() {
        if (this._connectionToEdit) {
            this._connectionToEditCopy = structuredClone(
                this._connectionToEdit,
            );
            const connection = await this.initializeConnectionForDialog(
                this._connectionToEdit,
            );
            this.state.connectionProfile = connection;

            this.state.selectedInputMode =
                connection.connectionString && connection.server === undefined
                    ? ConnectionInputMode.ConnectionString
                    : ConnectionInputMode.Parameters;
            this.updateState();
        }
    }

    private async loadEmptyConnection() {
        const emptyConnection = {
            authenticationType: AuthenticationType.SqlLogin,
            connectTimeout: 15, // seconds
            applicationName: "vscode-mssql",
        } as IConnectionDialogProfile;
        this.state.connectionProfile = emptyConnection;
    }

    private async initializeConnectionForDialog(
        connection: IConnectionInfo,
    ): Promise<IConnectionDialogProfile> {
        // Load the password if it's saved
        const isConnectionStringConnection =
            connection.connectionString !== undefined &&
            connection.connectionString !== "";
        if (!isConnectionStringConnection) {
            const password =
                await this._mainController.connectionManager.connectionStore.lookupPassword(
                    connection,
                    isConnectionStringConnection,
                );
            connection.password = password;
        } else {
            // If the connection is a connection string connection with SQL Auth:
            //   * the full connection string is stored as the "password" in the credential store
            //   * we need to extract the password from the connection string
            // If the connection is a connection string connection with a different auth type, then there's nothing in the credential store.

            const connectionString =
                await this._mainController.connectionManager.connectionStore.lookupPassword(
                    connection,
                    isConnectionStringConnection,
                );

            if (connectionString) {
                const passwordIndex = connectionString
                    .toLowerCase()
                    .indexOf("password=");

                if (passwordIndex !== -1) {
                    // extract password from connection string; found between 'Password=' and the next ';'
                    const passwordStart = passwordIndex + "password=".length;
                    const passwordEnd = connectionString.indexOf(
                        ";",
                        passwordStart,
                    );
                    if (passwordEnd !== -1) {
                        connection.password = connectionString.substring(
                            passwordStart,
                            passwordEnd,
                        );
                    }

                    // clear the connection string from the IConnectionDialogProfile so that the ugly connection string key
                    // that's used to look up the actual connection string (with password) isn't displayed
                    connection.connectionString = "";
                }
            }
        }

        const dialogConnection = connection as IConnectionDialogProfile;
        // Set the display name
        dialogConnection.displayName = dialogConnection.profileName
            ? dialogConnection.profileName
            : getConnectionDisplayName(connection);
        return dialogConnection;
    }

    private async updateItemVisibility() {
        let hiddenProperties: (keyof IConnectionDialogProfile)[] = [];

        if (
            this.state.selectedInputMode === ConnectionInputMode.Parameters ||
            this.state.selectedInputMode === ConnectionInputMode.AzureBrowse
        ) {
            if (
                this.state.connectionProfile.authenticationType !==
                AuthenticationType.SqlLogin
            ) {
                hiddenProperties.push("user", "password", "savePassword");
            }
            if (
                this.state.connectionProfile.authenticationType !==
                AuthenticationType.AzureMFA
            ) {
                hiddenProperties.push("accountId", "tenantId");
            }
            if (
                this.state.connectionProfile.authenticationType ===
                AuthenticationType.AzureMFA
            ) {
                // Hide tenantId if accountId has only one tenant
                const tenants = await this.getTenants(
                    this.state.connectionProfile.accountId,
                );
                if (tenants.length === 1) {
                    hiddenProperties.push("tenantId");
                }
            }
        }

        for (const component of Object.values(
            this.state.connectionComponents.components,
        )) {
            component.hidden = hiddenProperties.includes(
                component.propertyName,
            );
        }
    }

    private getActiveFormComponents(): (keyof IConnectionDialogProfile)[] {
        if (
            this.state.selectedInputMode === ConnectionInputMode.Parameters ||
            this.state.selectedInputMode === ConnectionInputMode.AzureBrowse
        ) {
            return this.state.connectionComponents.mainOptions;
        }
        return ["connectionString", "profileName"];
    }

    private getFormComponent(
        propertyName: keyof IConnectionDialogProfile,
    ): FormItemSpec<IConnectionDialogProfile> | undefined {
        return this.getActiveFormComponents().includes(propertyName)
            ? this.state.connectionComponents.components[propertyName]
            : undefined;
    }

    private async getAccounts(): Promise<FormItemOptions[]> {
        let accounts: IAccount[] = [];
        try {
            accounts =
                await this._mainController.azureAccountService.getAccounts();
            return accounts.map((account) => {
                return {
                    displayName: account.displayInfo.displayName,
                    value: account.displayInfo.userId,
                };
            });
        } catch (error) {
            console.error(
                `Error loading Azure accounts: ${getErrorMessage(error)}`,
            );

            sendErrorEvent(
                TelemetryViews.ConnectionDialog,
                TelemetryActions.LoadAzureAccountsForEntraAuth,
                error,
                false, // includeErrorMessage
                undefined, // errorCode
                undefined, // errorType
                undefined, // additionalProperties
                {
                    accountCount: accounts.length,
                    undefinedAccountCount: accounts.filter(
                        (x) => x === undefined,
                    ).length,
                    undefinedDisplayInfoCount: accounts.filter(
                        (x) => x !== undefined && x.displayInfo === undefined,
                    ).length,
                }, // additionalMeasurements
            );

            return [];
        }
    }

    private async getTenants(accountId: string): Promise<FormItemOptions[]> {
        let tenants: ITenant[] = [];
        try {
            const account = (
                await this._mainController.azureAccountService.getAccounts()
            ).find((account) => account.displayInfo?.userId === accountId);
            if (!account) {
                return [];
            }
            tenants = account.properties.tenants;
            if (!tenants) {
                return [];
            }
            return tenants.map((tenant) => {
                return {
                    displayName: tenant.displayName,
                    value: tenant.id,
                };
            });
        } catch (error) {
            console.error(
                `Error loading Azure tenants: ${getErrorMessage(error)}`,
            );

            sendErrorEvent(
                TelemetryViews.ConnectionDialog,
                TelemetryActions.LoadAzureTenantsForEntraAuth,
                error,
                false, // includeErrorMessage
                undefined, // errorCode
                undefined, // errorType
                undefined, // additionalProperties
                {
                    tenant: tenants.length,
                    undefinedTenantCount: tenants.filter((x) => x === undefined)
                        .length,
                }, // additionalMeasurements
            );

            return [];
        }
    }

    private convertToFormComponent(
        connOption: ConnectionOption,
    ): FormItemSpec<IConnectionDialogProfile> {
        switch (connOption.valueType) {
            case "boolean":
                return {
                    propertyName:
                        connOption.name as keyof IConnectionDialogProfile,
                    label: connOption.displayName,
                    required: connOption.isRequired,
                    type: FormItemType.Checkbox,
                    tooltip: connOption.description,
                };
            case "string":
                return {
                    propertyName:
                        connOption.name as keyof IConnectionDialogProfile,
                    label: connOption.displayName,
                    required: connOption.isRequired,
                    type: FormItemType.Input,
                    tooltip: connOption.description,
                };
            case "password":
                return {
                    propertyName:
                        connOption.name as keyof IConnectionDialogProfile,
                    label: connOption.displayName,
                    required: connOption.isRequired,
                    type: FormItemType.Password,
                    tooltip: connOption.description,
                };

            case "number":
                return {
                    propertyName:
                        connOption.name as keyof IConnectionDialogProfile,
                    label: connOption.displayName,
                    required: connOption.isRequired,
                    type: FormItemType.Input,
                    tooltip: connOption.description,
                };
            case "category":
                return {
                    propertyName:
                        connOption.name as keyof IConnectionDialogProfile,
                    label: connOption.displayName,
                    required: connOption.isRequired,
                    type: FormItemType.Dropdown,
                    tooltip: connOption.description,
                    options: connOption.categoryValues.map((v) => {
                        return {
                            displayName: v.displayName ?? v.name, // Use name if displayName is not provided
                            value: v.name,
                        };
                    }),
                };
            default:
                const error = `Unhandled connection option type: ${connOption.valueType}`;
                ConnectionDialogWebviewController._logger.log(error);
                sendErrorEvent(
                    TelemetryViews.ConnectionDialog,
                    TelemetryActions.LoadConnectionProperties,
                    new Error(error),
                    true, // includeErrorMessage
                );
        }
    }

    private async completeFormComponents(
        components: Partial<
            Record<keyof IConnectionDialogProfile, ConnectionDialogFormItemSpec>
        >,
    ) {
        // Add additional components that are not part of the connection options
        components["profileName"] = {
            propertyName: "profileName",
            label: Loc.profileName,
            required: false,
            type: FormItemType.Input,
            isAdvancedOption: false,
        };

        components["savePassword"] = {
            propertyName: "savePassword",
            label: Loc.savePassword,
            required: false,
            type: FormItemType.Checkbox,
            isAdvancedOption: false,
        };

        components["accountId"] = {
            propertyName: "accountId",
            label: Loc.azureAccount,
            required: true,
            type: FormItemType.Dropdown,
            options: await this.getAccounts(),
            placeholder: Loc.selectAnAccount,
            actionButtons: await this.getAzureActionButtons(),
            validate: (value: string) => {
                if (
                    this.state.connectionProfile.authenticationType ===
                        AuthenticationType.AzureMFA &&
                    !value
                ) {
                    return {
                        isValid: false,
                        validationMessage: Loc.azureAccountIsRequired,
                    };
                }
                return {
                    isValid: true,
                    validationMessage: "",
                };
            },
            isAdvancedOption: false,
        };

        components["tenantId"] = {
            propertyName: "tenantId",
            label: Loc.tenantId,
            required: true,
            type: FormItemType.Dropdown,
            options: [],
            hidden: true,
            placeholder: Loc.selectATenant,
            validate: (value: string) => {
                if (
                    this.state.connectionProfile.authenticationType ===
                        AuthenticationType.AzureMFA &&
                    !value
                ) {
                    return {
                        isValid: false,
                        validationMessage: Loc.tenantIdIsRequired,
                    };
                }
                return {
                    isValid: true,
                    validationMessage: "",
                };
            },
            isAdvancedOption: false,
        };

        components["connectionString"] = {
            type: FormItemType.TextArea,
            propertyName: "connectionString",
            label: Loc.connectionString,
            required: true,
            validate: (value: string) => {
                if (
                    this.state.selectedInputMode ===
                        ConnectionInputMode.ConnectionString &&
                    !value
                ) {
                    return {
                        isValid: false,
                        validationMessage: Loc.connectionStringIsRequired,
                    };
                }
                return {
                    isValid: true,
                    validationMessage: "",
                };
            },
            isAdvancedOption: false,
        };

        // add missing validation functions for generated components
        components["server"].validate = (value: string) => {
            if (
                this.state.connectionProfile.authenticationType ===
                    AuthenticationType.SqlLogin &&
                !value
            ) {
                return {
                    isValid: false,
                    validationMessage: Loc.serverIsRequired,
                };
            }
            return {
                isValid: true,
                validationMessage: "",
            };
        };

        components["user"].validate = (value: string) => {
            if (
                this.state.connectionProfile.authenticationType ===
                    AuthenticationType.SqlLogin &&
                !value
            ) {
                return {
                    isValid: false,
                    validationMessage: Loc.usernameIsRequired,
                };
            }
            return {
                isValid: true,
                validationMessage: "",
            };
        };
    }

    private async generateConnectionComponents(): Promise<
        Record<keyof IConnectionDialogProfile, ConnectionDialogFormItemSpec>
    > {
        // get list of connection options from Tools Service
        const capabilitiesResult: CapabilitiesResult =
            await this._mainController.connectionManager.client.sendRequest(
                GetCapabilitiesRequest.type,
                {},
            );
        const connectionOptions: ConnectionOption[] =
            capabilitiesResult.capabilities.connectionProvider.options;

        const groupNames =
            capabilitiesResult.capabilities.connectionProvider
                .groupDisplayNames;

        const result: Record<
            keyof IConnectionDialogProfile,
            ConnectionDialogFormItemSpec
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        > = {} as any; // force empty record for intial blank state

        for (const option of connectionOptions) {
            try {
                result[option.name as keyof IConnectionDialogProfile] = {
                    ...this.convertToFormComponent(option),
                    isAdvancedOption: !this._mainOptionNames.has(option.name),
                    optionCategory: option.groupName,
                    optionCategoryLabel:
                        groupNames[option.groupName] ?? option.groupName,
                };
            } catch (err) {
                console.error(
                    `Error loading connection option '${option.name}': ${getErrorMessage(err)}`,
                );
                sendErrorEvent(
                    TelemetryViews.ConnectionDialog,
                    TelemetryActions.LoadConnectionProperties,
                    err,
                    true, // includeErrorMessage
                    undefined, // errorCode
                    undefined, // errorType
                    {
                        connectionOptionName: option.name,
                    }, // additionalProperties
                );
            }
        }

        await this.completeFormComponents(result);

        return result;
    }

    private groupAdvancedOptions(
        componentsInfo: ConnectionComponentsInfo,
    ): ConnectionComponentGroup[] {
        const groupMap: Map<string, ConnectionComponentGroup> = new Map([
            // intialize with display order; any that aren't pre-defined will be appended
            // these values must match the GroupName defined in SQL Tools Service.
            ["security", undefined],
            ["initialization", undefined],
            ["resiliency", undefined],
            ["pooling", undefined],
            ["context", undefined],
        ]);

        const optionsToGroup = Object.values(componentsInfo.components).filter(
            (c) =>
                c.isAdvancedOption &&
                !componentsInfo.mainOptions.includes(c.propertyName) &&
                !componentsInfo.topAdvancedOptions.includes(c.propertyName),
        );

        for (const option of optionsToGroup) {
            if (
                // new group ID or group ID hasn't been initialized yet
                !groupMap.has(option.optionCategory) ||
                groupMap.get(option.optionCategory) === undefined
            ) {
                groupMap.set(option.optionCategory, {
                    groupName: option.optionCategoryLabel,
                    options: [option.propertyName],
                });
            } else {
                groupMap
                    .get(option.optionCategory)
                    .options.push(option.propertyName);
            }
        }

        return Array.from(groupMap.values());
    }

    private _mainOptionNames = new Set<string>([
        "server",
        "authenticationType",
        "user",
        "password",
        "savePassword",
        "accountId",
        "tenantId",
        "database",
        "trustServerCertificate",
        "encrypt",
        "profileName",
    ]);

    private async validateConnectionProfile(
        connectionProfile: IConnectionDialogProfile,
        propertyName?: keyof IConnectionDialogProfile,
    ): Promise<string[]> {
        const erroredInputs = [];
        if (propertyName) {
            const component = this.getFormComponent(propertyName);
            if (component && component.validate) {
                component.validation = component.validate(
                    connectionProfile[propertyName],
                );
                if (!component.validation.isValid) {
                    erroredInputs.push(component.propertyName);
                }
            }
        } else {
            this.getActiveFormComponents()
                .map((x) => this.state.connectionComponents.components[x])
                .forEach((c) => {
                    if (c.hidden) {
                        c.validation = {
                            isValid: true,
                            validationMessage: "",
                        };
                        return;
                    } else {
                        if (c.validate) {
                            c.validation = c.validate(
                                connectionProfile[c.propertyName],
                            );
                            if (!c.validation.isValid) {
                                erroredInputs.push(c.propertyName);
                            }
                        }
                    }
                });
        }

        return erroredInputs;
    }

    private async getAzureActionButtons(): Promise<FormItemActionButton[]> {
        const actionButtons: FormItemActionButton[] = [];
        actionButtons.push({
            label: Loc.signIn,
            id: "azureSignIn",
            callback: async () => {
                const account =
                    await this._mainController.azureAccountService.addAccount();
                const accountsComponent = this.getFormComponent("accountId");
                if (accountsComponent) {
                    accountsComponent.options = await this.getAccounts();
                    this.state.connectionProfile.accountId = account.key.id;
                    this.updateState();
                    await this.handleAzureMFAEdits("accountId");
                }
            },
        });
        if (
            this.state.connectionProfile.authenticationType ===
                AuthenticationType.AzureMFA &&
            this.state.connectionProfile.accountId
        ) {
            const account = (
                await this._mainController.azureAccountService.getAccounts()
            ).find(
                (account) =>
                    account.displayInfo.userId ===
                    this.state.connectionProfile.accountId,
            );
            if (account) {
                const session =
                    await this._mainController.azureAccountService.getAccountSecurityToken(
                        account,
                        undefined,
                    );
                const isTokenExpired = AzureController.isTokenInValid(
                    session.token,
                    session.expiresOn,
                );
                if (isTokenExpired) {
                    actionButtons.push({
                        label: refreshTokenLabel,
                        id: "refreshToken",
                        callback: async () => {
                            const account = (
                                await this._mainController.azureAccountService.getAccounts()
                            ).find(
                                (account) =>
                                    account.displayInfo.userId ===
                                    this.state.connectionProfile.accountId,
                            );
                            if (account) {
                                const session =
                                    await this._mainController.azureAccountService.getAccountSecurityToken(
                                        account,
                                        undefined,
                                    );
                                ConnectionDialogWebviewController._logger.log(
                                    "Token refreshed",
                                    session.expiresOn,
                                );
                            }
                        },
                    });
                }
            }
        }
        return actionButtons;
    }

    private async handleAzureMFAEdits(
        propertyName: keyof IConnectionDialogProfile,
    ) {
        const mfaComponents: (keyof IConnectionDialogProfile)[] = [
            "accountId",
            "tenantId",
            "authenticationType",
        ];
        if (mfaComponents.includes(propertyName)) {
            if (
                this.state.connectionProfile.authenticationType !==
                AuthenticationType.AzureMFA
            ) {
                return;
            }
            const accountComponent = this.getFormComponent("accountId");
            const tenantComponent = this.getFormComponent("tenantId");
            let tenants: FormItemOptions[] = [];
            switch (propertyName) {
                case "accountId":
                    tenants = await this.getTenants(
                        this.state.connectionProfile.accountId,
                    );
                    if (tenantComponent) {
                        tenantComponent.options = tenants;
                        if (tenants && tenants.length > 0) {
                            this.state.connectionProfile.tenantId =
                                tenants[0].value;
                        }
                    }
                    accountComponent.actionButtons =
                        await this.getAzureActionButtons();
                    break;
                case "tenantId":
                    break;
                case "authenticationType":
                    const firstOption = accountComponent.options[0];
                    if (firstOption) {
                        this.state.connectionProfile.accountId =
                            firstOption.value;
                    }
                    tenants = await this.getTenants(
                        this.state.connectionProfile.accountId,
                    );
                    if (tenantComponent) {
                        tenantComponent.options = tenants;
                        if (tenants && tenants.length > 0) {
                            this.state.connectionProfile.tenantId =
                                tenants[0].value;
                        }
                    }
                    accountComponent.actionButtons =
                        await this.getAzureActionButtons();
                    break;
            }
        }
    }

    private clearFormError() {
        this.state.formError = "";
        for (const component of this.getActiveFormComponents().map(
            (x) => this.state.connectionComponents.components[x],
        )) {
            component.validation = undefined;
        }
    }

    private registerRpcHandlers() {
        this.registerReducer(
            "setConnectionInputType",
            async (state, payload) => {
                this.state.selectedInputMode = payload.inputMode;
                await this.updateItemVisibility();
                this.updateState();

                if (
                    this.state.selectedInputMode ===
                    ConnectionInputMode.AzureBrowse
                ) {
                    await this.loadAllAzureServers(state);
                }

                return state;
            },
        );

        this.registerReducer("formAction", async (state, payload) => {
            if (payload.event.isAction) {
                const component = this.getFormComponent(
                    payload.event.propertyName,
                );
                if (component && component.actionButtons) {
                    const actionButton = component.actionButtons.find(
                        (b) => b.id === payload.event.value,
                    );
                    if (actionButton?.callback) {
                        await actionButton.callback();
                    }
                }
            } else {
                (this.state.connectionProfile[
                    payload.event.propertyName
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ] as any) = payload.event.value;
                await this.validateConnectionProfile(
                    this.state.connectionProfile,
                    payload.event.propertyName,
                );
                await this.handleAzureMFAEdits(payload.event.propertyName);
            }
            await this.updateItemVisibility();

            return state;
        });

        this.registerReducer("loadConnection", async (state, payload) => {
            sendActionEvent(
                TelemetryViews.ConnectionDialog,
                TelemetryActions.LoadConnection,
            );

            this._connectionToEditCopy = structuredClone(payload.connection);
            this.clearFormError();
            this.state.connectionProfile = payload.connection;

            this.state.selectedInputMode = this._connectionToEditCopy
                .connectionString
                ? ConnectionInputMode.ConnectionString
                : ConnectionInputMode.Parameters;
            await this.updateItemVisibility();
            await this.handleAzureMFAEdits("azureAuthType");
            await this.handleAzureMFAEdits("accountId");

            return state;
        });

        this.registerReducer("connect", async (state) => {
            return this.connectHelper(state);
        });

        this.registerReducer("loadAzureServers", async (state, payload) => {
            await this.loadAzureServersForSubscription(
                state,
                payload.subscriptionId,
            );

            return state;
        });

        this.registerReducer("addFirewallRule", async (state, payload) => {
            const [startIp, endIp] =
                typeof payload.ip === "string"
                    ? [payload.ip, payload.ip]
                    : [payload.ip.startIp, payload.ip.endIp];

            console.debug(
                `Setting firewall rule: "${payload.name}" (${startIp} - ${endIp})`,
            );
            let account, tokenMappings;

            try {
                ({ account, tokenMappings } =
                    await this.constructAzureAccountForTenant(
                        payload.tenantId,
                    ));
            } catch (err) {
                state.formError = Loc.errorCreatingFirewallRule(
                    `"${payload.name}" (${startIp} - ${endIp})`,
                    getErrorMessage(err),
                );

                state.dialog = undefined;

                sendErrorEvent(
                    TelemetryViews.ConnectionDialog,
                    TelemetryActions.AddFirewallRule,
                    err,
                    false, // includeErrorMessage
                    undefined, // errorCode
                    undefined, // errorType
                    {
                        failure: "constructAzureAccountForTenant",
                    },
                );

                return state;
            }

            const result =
                await this._mainController.connectionManager.firewallService.createFirewallRule(
                    {
                        account: account,
                        firewallRuleName: payload.name,
                        startIpAddress: startIp,
                        endIpAddress: endIp,
                        serverName: this.state.connectionProfile.server,
                        securityTokenMappings: tokenMappings,
                    },
                );

            if (!result.result) {
                state.formError = Loc.errorCreatingFirewallRule(
                    `"${payload.name}" (${startIp} - ${endIp})`,
                    result.errorMessage,
                );

                sendErrorEvent(
                    TelemetryViews.ConnectionDialog,
                    TelemetryActions.AddFirewallRule,
                    new Error(result.errorMessage),
                    false, // includeErrorMessage
                    undefined, // errorCode
                    undefined, // errorType
                    {
                        failure: "firewallService.createFirewallRule",
                    },
                );
            }

            sendActionEvent(
                TelemetryViews.ConnectionDialog,
                TelemetryActions.AddFirewallRule,
            );

            state.dialog = undefined;
            this.updateState(state);

            return await this.connectHelper(state);
        });

        this.registerReducer("closeDialog", async (state) => {
            state.dialog = undefined;
            return state;
        });

        this.registerReducer("filterAzureSubscriptions", async (state) => {
            await promptForAzureSubscriptionFilter(state);
            await this.loadAllAzureServers(state);

            return state;
        });

        this.registerReducer("refreshConnectionsList", async (state) => {
            await this.updateLoadedConnections(state);

            return state;
        });

        this.registerReducer(
            "deleteSavedConnection",
            async (state, payload) => {
                const confirm = await vscode.window.showQuickPick(
                    [LocCommon.delete, LocCommon.cancel],
                    {
                        title: LocCommon.areYouSureYouWantTo(
                            Loc.deleteTheSavedConnection(
                                payload.connection.displayName,
                            ),
                        ),
                    },
                );

                if (confirm !== LocCommon.delete) {
                    return state;
                }

                const success =
                    await this._mainController.connectionManager.connectionStore.removeProfile(
                        payload.connection as IConnectionProfile,
                    );

                if (success) {
                    await this.updateLoadedConnections(state);
                }

                return state;
            },
        );

        this.registerReducer(
            "removeRecentConnection",
            async (state, payload) => {
                await this._mainController.connectionManager.connectionStore.removeRecentlyUsed(
                    payload.connection as IConnectionProfile,
                );

                await this.updateLoadedConnections(state);

                return state;
            },
        );
    }

    //#region Helpers

    //#region Connection helpers

    private async connectHelper(
        state: ConnectionDialogWebviewState,
    ): Promise<ConnectionDialogWebviewState> {
        this.clearFormError();
        this.state.connectionStatus = ApiStatus.Loading;
        this.updateState();

        const cleanedConnection: IConnectionDialogProfile = structuredClone(
            this.state.connectionProfile,
        );
        this.cleanConnection(cleanedConnection); // clean the connection by clearing the options that aren't being used

        // Perform final validation of all inputs
        const erroredInputs =
            await this.validateConnectionProfile(cleanedConnection);
        if (erroredInputs.length > 0) {
            this.state.connectionStatus = ApiStatus.Error;
            console.warn(
                "One more more inputs have errors: " + erroredInputs.join(", "),
            );
            return state;
        }

        try {
            try {
                const result =
                    await this._mainController.connectionManager.connectionUI.validateAndSaveProfileFromDialog(
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        cleanedConnection as any,
                    );

                if (result.errorMessage) {
                    return await this.handleConnectionErrorCodes(result, state);
                }
            } catch (error) {
                this.state.formError = getErrorMessage(error);
                this.state.connectionStatus = ApiStatus.Error;

                sendErrorEvent(
                    TelemetryViews.ConnectionDialog,
                    TelemetryActions.CreateConnection,
                    error,
                    false, // includeErrorMessage
                    undefined, // errorCode
                    undefined, // errorType
                    {
                        connectionInputType: this.state.selectedInputMode,
                        authMode:
                            this.state.connectionProfile.authenticationType,
                    },
                );

                return state;
            }

            sendActionEvent(
                TelemetryViews.ConnectionDialog,
                TelemetryActions.CreateConnection,
                {
                    result: "success",
                    newOrEditedConnection: this._connectionToEditCopy
                        ? "edited"
                        : "new",
                    connectionInputType: this.state.selectedInputMode,
                    authMode: this.state.connectionProfile.authenticationType,
                },
            );

            if (this._connectionToEditCopy) {
                await this._mainController.connectionManager.getUriForConnection(
                    this._connectionToEditCopy,
                );
                await this._objectExplorerProvider.removeConnectionNodes([
                    this._connectionToEditCopy,
                ]);

                await this._mainController.connectionManager.connectionStore.removeProfile(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    this._connectionToEditCopy as any,
                );
                this._objectExplorerProvider.refresh(undefined);
            }

            await this._mainController.connectionManager.connectionUI.saveProfile(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                this.state.connectionProfile as any,
            );
            const node =
                await this._mainController.createObjectExplorerSessionFromDialog(
                    this.state.connectionProfile,
                );

            this._objectExplorerProvider.refresh(undefined);
            await this.updateLoadedConnections(state);
            this.updateState();

            this.state.connectionStatus = ApiStatus.Loaded;
            await this._mainController.objectExplorerTree.reveal(node, {
                focus: true,
                select: true,
                expand: true,
            });
            await this.panel.dispose();
            await UserSurvey.getInstance().promptUserForNPSFeedback();
        } catch (error) {
            this.state.connectionStatus = ApiStatus.Error;

            sendErrorEvent(
                TelemetryViews.ConnectionDialog,
                TelemetryActions.CreateConnection,
                error,
                undefined, // includeErrorMessage
                undefined, // errorCode
                undefined, // errorType
                {
                    connectionInputType: this.state.selectedInputMode,
                    authMode: this.state.connectionProfile.authenticationType,
                },
            );

            return state;
        }
        return state;
    }

    private async handleConnectionErrorCodes(
        result: ConnectionCompleteParams,
        state: ConnectionDialogWebviewState,
    ): Promise<ConnectionDialogWebviewState> {
        if (result.errorNumber === connectionCertValidationFailedErrorCode) {
            this.state.connectionStatus = ApiStatus.Error;
            this.state.dialog = {
                type: "trustServerCert",
                message: result.errorMessage,
            } as TrustServerCertDialogProps;

            // connection failing because the user didn't trust the server cert is not an error worth logging;
            // just prompt the user to trust the cert

            return state;
        } else if (result.errorNumber === connectionFirewallErrorCode) {
            this.state.connectionStatus = ApiStatus.Error;

            const handleFirewallErrorResult =
                await this._mainController.connectionManager.firewallService.handleFirewallRule(
                    result.errorNumber,
                    result.errorMessage,
                );

            if (!handleFirewallErrorResult.result) {
                sendErrorEvent(
                    TelemetryViews.ConnectionDialog,
                    TelemetryActions.AddFirewallRule,
                    new Error(result.errorMessage),
                    true, // includeErrorMessage; parse failed because it couldn't detect an IP address, so that'd be the only PII
                    undefined, // errorCode
                    undefined, // errorType
                );

                // Proceed with 0.0.0.0 as the client IP, and let user fill it out manually.
                handleFirewallErrorResult.ipAddress = "0.0.0.0";
            }

            const auth = await confirmVscodeAzureSignin();
            const tenants = await auth.getTenants();

            this.state.dialog = {
                type: "addFirewallRule",
                message: result.errorMessage,
                clientIp: handleFirewallErrorResult.ipAddress,
                tenants: tenants.map((t) => {
                    return {
                        name: t.displayName,
                        id: t.tenantId,
                    };
                }),
            } as AddFirewallRuleDialogProps;

            return state;
        }

        this.state.formError = result.errorMessage;
        this.state.connectionStatus = ApiStatus.Error;

        sendActionEvent(
            TelemetryViews.ConnectionDialog,
            TelemetryActions.CreateConnection,
            {
                result: "connectionError",
                errorNumber: String(result.errorNumber),
                newOrEditedConnection: this._connectionToEditCopy
                    ? "edited"
                    : "new",
                connectionInputType: this.state.selectedInputMode,
                authMode: this.state.connectionProfile.authenticationType,
            },
        );

        return state;
    }

    //#endregion

    //#region Azure helpers

    private async constructAzureAccountForTenant(
        tenantId: string,
    ): Promise<{ account: IAccount; tokenMappings: {} }> {
        const auth = await confirmVscodeAzureSignin();
        const subs = await auth.getSubscriptions(false /* filter */);
        const sub = subs.filter((s) => s.tenantId === tenantId)[0];

        if (!sub) {
            throw new Error(
                Loc.errorLoadingAzureAccountInfoForTenantId(tenantId),
            );
        }

        const token = await sub.credential.getToken(".default");

        const session = await sub.authentication.getSession();

        const account: IAccount = {
            displayInfo: {
                displayName: session.account.label,
                userId: session.account.label,
                name: session.account.label,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                accountType: (session.account as any).type as any,
            },
            key: {
                providerId: "microsoft",
                id: session.account.label,
            },
            isStale: false,
            properties: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                azureAuthType: 0 as any,
                providerSettings: undefined,
                isMsAccount: false,
                owningTenant: undefined,
                tenants: [
                    {
                        displayName: sub.tenantId,
                        id: sub.tenantId,
                        userId: token.token,
                    },
                ],
            },
        };

        const tokenMappings = {};
        tokenMappings[sub.tenantId] = {
            Token: token.token,
        };

        return { account, tokenMappings };
    }

    private async loadAzureSubscriptions(
        state: ConnectionDialogWebviewState,
    ): Promise<Map<string, AzureSubscription[]> | undefined> {
        let endActivity: ActivityObject;
        try {
            const auth = await confirmVscodeAzureSignin();

            if (!auth) {
                state.formError = l10n.t("Azure sign in failed.");
                return undefined;
            }

            state.loadingAzureSubscriptionsStatus = ApiStatus.Loading;
            this.updateState();

            // getSubscriptions() below checks this config setting if filtering is specified.  If the user has this set, then we use it; if not, we get all subscriptions.
            // The specific vscode config setting it uses is hardcoded into the VS Code Azure SDK, so we need to use the same value here.
            const shouldUseFilter =
                vscode.workspace
                    .getConfiguration()
                    .get<
                        string[] | undefined
                    >(azureSubscriptionFilterConfigKey) !== undefined;

            endActivity = startActivity(
                TelemetryViews.ConnectionDialog,
                TelemetryActions.LoadAzureSubscriptions,
            );

            this._azureSubscriptions = new Map(
                (await auth.getSubscriptions(shouldUseFilter)).map((s) => [
                    s.subscriptionId,
                    s,
                ]),
            );
            const tenantSubMap = this.groupBy<string, AzureSubscription>(
                Array.from(this._azureSubscriptions.values()),
                "tenantId",
            ); // TODO: replace with Object.groupBy once ES2024 is supported

            const subs: AzureSubscriptionInfo[] = [];

            for (const t of tenantSubMap.keys()) {
                for (const s of tenantSubMap.get(t)) {
                    subs.push({
                        id: s.subscriptionId,
                        name: s.name,
                        loaded: false,
                    });
                }
            }

            state.azureSubscriptions = subs;
            state.loadingAzureSubscriptionsStatus = ApiStatus.Loaded;

            endActivity.end(
                ActivityStatus.Succeeded,
                undefined, // additionalProperties
                {
                    subscriptionCount: subs.length,
                },
            );
            this.updateState();

            return tenantSubMap;
        } catch (error) {
            state.formError = l10n.t("Error loading Azure subscriptions.");
            state.loadingAzureSubscriptionsStatus = ApiStatus.Error;
            console.error(state.formError + "\n" + getErrorMessage(error));
            endActivity.endFailed(error, false);
            return undefined;
        }
    }

    private async loadAllAzureServers(
        state: ConnectionDialogWebviewState,
    ): Promise<void> {
        const endActivity = startActivity(
            TelemetryViews.ConnectionDialog,
            TelemetryActions.LoadAzureServers,
        );
        try {
            const tenantSubMap = await this.loadAzureSubscriptions(state);

            if (!tenantSubMap) {
                return;
            }

            if (tenantSubMap.size === 0) {
                state.formError = l10n.t(
                    "No subscriptions available.  Adjust your subscription filters to try again.",
                );
            } else {
                state.loadingAzureServersStatus = ApiStatus.Loading;
                state.azureServers = [];
                this.updateState();
                const promiseArray: Promise<void>[] = [];
                for (const t of tenantSubMap.keys()) {
                    for (const s of tenantSubMap.get(t)) {
                        promiseArray.push(
                            this.loadAzureServersForSubscription(
                                state,
                                s.subscriptionId,
                            ),
                        );
                    }
                }
                await Promise.all(promiseArray);
                endActivity.end(
                    ActivityStatus.Succeeded,
                    undefined, // additionalProperties
                    {
                        subscriptionCount: promiseArray.length,
                    },
                );

                state.loadingAzureServersStatus = ApiStatus.Loaded;
                return;
            }
        } catch (error) {
            state.formError = l10n.t("Error loading Azure databases.");
            state.loadingAzureServersStatus = ApiStatus.Error;
            console.error(state.formError + "\n" + getErrorMessage(error));

            endActivity.endFailed(
                error,
                false, // includeErrorMessage
            );
            return;
        }
    }

    private async loadAzureServersForSubscription(
        state: ConnectionDialogWebviewState,
        subscriptionId: string,
    ) {
        const azSub = this._azureSubscriptions.get(subscriptionId);
        const stateSub = state.azureSubscriptions.find(
            (s) => s.id === subscriptionId,
        );

        try {
            const servers = await fetchServersFromAzure(azSub);
            state.azureServers.push(...servers);
            stateSub.loaded = true;
            this.updateState();
            console.log(
                `Loaded ${servers.length} servers for subscription ${azSub.name} (${azSub.subscriptionId})`,
            );
        } catch (error) {
            console.error(
                Loc.errorLoadingAzureDatabases(
                    azSub.name,
                    azSub.subscriptionId,
                ),
                +"\n" + getErrorMessage(error),
            );

            sendErrorEvent(
                TelemetryViews.ConnectionDialog,
                TelemetryActions.LoadAzureServers,
                error,
                true, // includeErrorMessage
                undefined, // errorCode
                undefined, // errorType
            );
        }
    }

    //#endregion

    //#region Miscellanous helpers

    private groupBy<K, V>(values: V[], key: keyof V): Map<K, V[]> {
        return values.reduce((rv, x) => {
            const keyValue = x[key] as K;
            if (!rv.has(keyValue)) {
                rv.set(keyValue, []);
            }
            rv.get(keyValue)!.push(x);
            return rv;
        }, new Map<K, V[]>());
    }

    /** Cleans up a connection profile by clearing the properties that aren't being used
     * (e.g. due to form selections, like authType and inputMode) */
    private cleanConnection(connection: IConnectionDialogProfile) {
        // Clear values for inputs that are hidden due to form selections
        for (const option of Object.values(
            this.state.connectionComponents.components,
        )) {
            if (option.hidden) {
                (connection[
                    option.propertyName as keyof IConnectionDialogProfile
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ] as any) = undefined;
            }
        }

        // Clear values for inputs that are not applicable due to the selected input mode
        if (
            this.state.selectedInputMode === ConnectionInputMode.Parameters ||
            this.state.selectedInputMode === ConnectionInputMode.AzureBrowse
        ) {
            connection.connectionString = undefined;
        } else if (
            this.state.selectedInputMode ===
            ConnectionInputMode.ConnectionString
        ) {
            Object.keys(connection).forEach((key) => {
                if (key !== "connectionString" && key !== "profileName") {
                    connection[key] = undefined;
                }
            });
        }
    }

    private async loadConnections(): Promise<{
        savedConnections: IConnectionDialogProfile[];
        recentConnections: IConnectionDialogProfile[];
    }> {
        const unsortedConnections: IConnectionCredentialsQuickPickItem[] =
            this._mainController.connectionManager.connectionStore.loadAllConnections(
                true /* addRecentConnections */,
            );

        const savedConnections = unsortedConnections
            .filter(
                (c) =>
                    c.quickPickItemType ===
                    CredentialsQuickPickItemType.Profile,
            )
            .map((c) => c.connectionCreds);

        const recentConnections = unsortedConnections
            .filter(
                (c) => c.quickPickItemType === CredentialsQuickPickItemType.Mru,
            )
            .map((c) => c.connectionCreds);

        sendActionEvent(
            TelemetryViews.ConnectionDialog,
            TelemetryActions.LoadRecentConnections,
            undefined, // additionalProperties
            {
                savedConnectionsCount: savedConnections.length,
                recentConnectionsCount: recentConnections.length,
            },
        );

        return {
            recentConnections: await Promise.all(
                recentConnections
                    .map((conn) => {
                        try {
                            return this.initializeConnectionForDialog(conn);
                        } catch (ex) {
                            console.error(
                                "Error initializing recent connection: " +
                                    getErrorMessage(ex),
                            );

                            sendErrorEvent(
                                TelemetryViews.ConnectionDialog,
                                TelemetryActions.LoadConnections,
                                ex,
                                false, // includeErrorMessage
                                undefined, // errorCode
                                undefined, // errorType
                                {
                                    connectionType: "recent",
                                    authType: conn.authenticationType,
                                },
                            );

                            return Promise.resolve(undefined);
                        }
                    })
                    .filter((c) => c !== undefined),
            ),
            savedConnections: await Promise.all(
                savedConnections
                    .map((conn) => {
                        try {
                            return this.initializeConnectionForDialog(conn);
                        } catch (ex) {
                            console.error(
                                "Error initializing saved connection: " +
                                    getErrorMessage(ex),
                            );

                            sendErrorEvent(
                                TelemetryViews.ConnectionDialog,
                                TelemetryActions.LoadConnections,
                                ex,
                                false, // includeErrorMessage
                                undefined, // errorCode
                                undefined, // errorType
                                {
                                    connectionType: "saved",
                                    authType: conn.authenticationType,
                                },
                            );

                            return Promise.resolve(undefined);
                        }
                    })
                    .filter((c) => c !== undefined),
            ),
        };
    }

    private async updateLoadedConnections(state: ConnectionDialogWebviewState) {
        const loadedConnections = await this.loadConnections();

        state.recentConnections = loadedConnections.recentConnections;
        state.savedConnections = loadedConnections.savedConnections;
    }

    //#endregion

    //#endregion
}
