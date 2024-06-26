import { cloneDeep, create } from 'lodash';
import _ from 'lodash'
import { __ } from "~/locale";
import { lookupCloudProviderAlias, slugify } from 'oc_vue_shared/util';
import {shouldConnectWithoutCopy} from 'oc_vue_shared/storage-keys.js';
import {appendDeploymentTemplateInBlueprint, appendResourceTemplateInDependent, createResourceTemplate, createEnvironmentInstance, deleteResourceTemplate, deleteResourceTemplateInDependent, deleteEnvironmentInstance, updatePropertyInInstance, updatePropertyInResourceTemplate, createResourceTemplateInDeploymentTemplate} from './deployment_template_updates.js';
import {constraintTypeFromRequirement} from 'oc_vue_shared/lib/resource-template'
import { importsAreEqual } from  'oc_vue_shared/client_utils/unfurl-server'
import {applyInputsSchema, customMerge} from 'oc_vue_shared/lib/node-filter'
import {isConfigurable} from 'oc_vue_shared/client_utils/resource_types'
import Vue from 'vue'

function dateSuffix() {
    return Date.now().toString(36)
}

const baseState = () => ({
    deploymentTemplate: {},
    resourceTemplates: {},
    inputValidationStatus: {},
    availableResourceTypes: [],
    tempRepositories: [],
});

const timeouts = {}

const state = baseState();

const mutations = {
    resetTemplateResourceState(state) {
        for(const [key, value] of Object.entries(baseState())){
            Vue.set(state, key, value)
        }
    },

    // TODO account for duplicate or enumerated properties
    setInputValidStatus(state, {card, path, status}) {
        const cardName = card?.name || card
        if(!state.inputValidationStatus[cardName]) {
            Vue.set(state.inputValidationStatus, cardName, {[path]: status})
        }
        else {
            Vue.set(state.inputValidationStatus[card?.name || card], path, status)
        }
    },

    setAvailableResourceTypes(state, resourceTypes) {
        state.availableResourceTypes = resourceTypes
    },

    setDeploymentTemplate(_state, deploymentTemplate) {
        // eslint-disable-next-line no-param-reassign
        _state.deploymentTemplate = {...deploymentTemplate};
    },

    createTemplateResource(_state, target ) {
        // eslint-disable-next-line no-param-reassign
        if(!target.name) return;
        Vue.set(
            _state.resourceTemplates,
            target.name,
            { ...target , type: typeof(target.type) == 'string'? target.type: target?.type?.name}
        )
    },

    createReference(_state, { dependentName, dependentRequirement, resourceTemplate, fieldsToReplace, constraintFieldsToReplace}){
        if(!dependentName) return
        const dependent = _state.resourceTemplates[dependentName];
        console.assert(dependent, `Expected parent ${dependentName} to exist for ${resourceTemplate?.name}`)
        const index = dependent.dependencies.findIndex(req => req.name == dependentRequirement);
        resourceTemplate.dependentName = dependentName;
        resourceTemplate.dependentRequirement = dependentRequirement;

        const dependency = {constraint: {match: resourceTemplate.name}, ...(dependent.dependencies[index] || {}), ...fieldsToReplace, match: resourceTemplate.name}
        if(constraintFieldsToReplace) {
            dependency.constraint = {...(dependency.constraint || {}), ...constraintFieldsToReplace}
        }
        if(index == -1) {
            dependent.dependencies.push(dependency)
        } else {
            dependent.dependencies[index] = dependency
        }
        Vue.set(_state.resourceTemplates, dependentName, {...dependent})
    },

    deleteReference(_state, { dependentName, dependentRequirement }) {
        if(dependentName && dependentRequirement) {
            const dependent = _state.resourceTemplates[dependentName];
            const index = dependent.dependencies.findIndex(req => req.name == dependentRequirement);
            const templateName = dependent.dependencies[index].match;
            dependent.dependencies[index] = {...dependent.dependencies[index], match: null, completionStatus: null, _valid: false};
            dependent.dependencies[index].constraint.match = null

            _state.resourceTemplates[dependentName] = {...dependent};

            _state.resourceTemplates = {..._state.resourceTemplates};
        }
    },

    removeCard(state, {templateName}) {
        delete state.resourceTemplates[templateName]
        state.resourceTemplates = {...state.resourceTemplates}
    },

    updateLastFetchedFrom(state, {projectPath, templateSlug, environmentName, noPrimary, sourceDeploymentTemplate}) {
        Vue.set(state, 'lastFetchedFrom', {projectPath, templateSlug, environmentName, noPrimary: noPrimary ?? false, sourceDeploymentTemplate});
    },

    setContext(state, context) {
        state.context = context
    },

    templateUpdateProperty(state, {templateName, propertyName, propertyValue, nestedPropName}) {
        const template = state.resourceTemplates[templateName]
        let property = template.properties.find(prop => prop.name == (nestedPropName || propertyName))
        if(property) {
            property.value = propertyValue
        } else {
            console.warn(`[OC] Updated a property "${propertyName}" with ${JSON.stringify(propertyValue)}.  This property was not found in the schema`)
            template.properties.push({name: (nestedPropName || propertyName), value: propertyValue})
        }
        Vue.set(state.resourceTemplates, templateName, template)
    },
}

const actions = {
    // used exclusively for /dashboard/deployment/<env>/<deployment> TODO merge with related actions
    async populateDeploymentResources({rootGetters, getters, commit, dispatch}, {deployment, environmentName}) {
        commit('resetTemplateResourceState')
        const isDeploymentTemplate = deployment.__typename == 'DeploymentTemplate'
        let deploymentTemplate = cloneDeep(rootGetters.resolveDeploymentTemplate(
            isDeploymentTemplate? deployment.name: deployment.deploymentTemplate
        ))
        if(!deploymentTemplate) {
            const message = `Could not lookup deployment blueprint '${deployment.deploymentTemplate}'`
            const e = new Error(message)
            e.flash = true
            throw e
        }
        if(!isDeploymentTemplate) deploymentTemplate = {...deploymentTemplate, ...deployment}
        let resource = isDeploymentTemplate? rootGetters.resolveResourceTemplate(deploymentTemplate.primary) : rootGetters.resolveResource(deploymentTemplate.primary)
        if(!resource) {
            const message = `Could not lookup resource '${deploymentTemplate.primary}'`
            const e = new Error(message)
            e.flash = true
            throw e
        }
        if(!isDeploymentTemplate) resource = {...resource, template: getters.dtResolveResourceTemplate(resource.template)}

        deploymentTemplate.primary = resource.name
        if(!deploymentTemplate.cloud) {
            const environment = rootGetters.lookupEnvironment(environmentName)
            if(environment?.primary_provider?.type) {
                deploymentTemplate.cloud = environment.primary_provider.type
            }
        }
        commit('updateLastFetchedFrom', {environmentName})
        commit('setDeploymentTemplate', deploymentTemplate)

        await dispatch('createMatchedResources', {resource, isDeploymentTemplate})
        commit('createTemplateResource', resource)
    },

    async recursiveInstantiate({ commit, getters, rootGetters, state: _state, dispatch}, node) {
        const deferred = []

        const isSubstitute = node.directives?.includes('substitute')
        const nestedTemplates = getters.getNestedTemplates(node)

        for(const dep of getters.getDependencies(node)) {
            const req = dep.constraint
            if(dep.match) {
                let matchedNested

                if(nestedTemplates && (matchedNested = nestedTemplates[dep.match])) {
                    // This will create a node to be substituted
                    // NOTE: the requirement that is added is based on the dependency match rather than its name


                    const substituteDependency = isSubstitute && node.dependencies.find(otherDep => otherDep.name == dep.match)
                    const substituteNodeExists = !!(substituteDependency && getters.dtResolveResourceTemplate(substituteDependency.match))


                    if(substituteNodeExists) continue

                    const shouldPerformSubstitution = isSubstitute && !substituteDependency

                    const dependentName = node.name // the root of the inner topology
                    const dependentRequirement = shouldPerformSubstitution? dep.match : dep.name // in the case of a substitution, the name of the source template from the inner topology

                    const nameUnmangled = shouldPerformSubstitution ? `${dep.name}-for-${node.name}` : dep.match
                    let name = nameUnmangled

                    if(!shouldPerformSubstitution) {
                        name = `${name}-${dateSuffix()}`
                    }

                    matchedNested = {
                        ...matchedNested,
                        _unmangled: nameUnmangled,
                        name,
                        metadata: {created_by: 'unfurl-gui'}
                    }

                    dispatch('normalizeUnfurlData', {
                        key: "ResourceTemplate",
                        entry: matchedNested,
                        root: rootGetters.getApplicationRoot,
                    })

                    // TODO figure out the disagreement here
                    matchedNested._ancestors = [...(node._ancestors || []), [node, dependentRequirement]]

                    commit(
                        'createReference',
                        {
                            dependentName,
                            dependentRequirement,
                            resourceTemplate: matchedNested,
                            fieldsToReplace: {...dep, name: dependentRequirement},
                            constraintFieldsToReplace: {...req, match: dep.match, name: dependentRequirement}
                        }
                    )

                    commit('createTemplateResource', matchedNested)

                    commit(
                        'pushPreparedMutation',
                        createResourceTemplate({...matchedNested, dependentName, dependentRequirement, deploymentTemplateName: _state.lastFetchedFrom.templateSlug}),
                        {root: true}
                    )

                    deferred.push(dispatch('recursiveInstantiate', matchedNested))
                }
                continue
            }
            if(req.min === 0) continue
            const availableResourceTypes = getters.availableResourceTypesForRequirement(dep, true)
            // TODO also create if the only available type is not user settable

            if(availableResourceTypes.length != 1) continue

            const type = availableResourceTypes[0]

            const typeRequiresUserInteraction = (
                req.visibility == 'hidden' ||
                Object.keys(type.inputsSchema.properties).length > 0
            )

            if(!typeRequiresUserInteraction) {
                const name = `${req.name}-for-${node.name}`
                deferred.push(
                    dispatch('createNodeResource', {
                        dependentName: node.name,
                        dependentRequirement: req.name,
                        requirement: req,
                        name: name,
                        title: name,
                        visibility: 'hidden',
                        selection: type,
                    })
                )
            }
        }
        await Promise.all(deferred)
    },

    // used by deploy and blueprint editing
    async populateTemplateResources({getters, rootGetters, commit, dispatch}, {projectPath, blueprintBranch, templateSlug, renameDeploymentTemplate, renamePrimary, syncState, environmentName}) {
        commit('resetTemplateResourceState')
        commit('setContext', environmentName? 'template': 'blueprint')
        if(!templateSlug) return false;

        let blueprint = rootGetters.getApplicationBlueprint;
        let deploymentTemplate = rootGetters.resolveDeploymentTemplate(templateSlug)

        // attach project/branch path here so we can recall it later
        deploymentTemplate = {...deploymentTemplate, projectPath, branch: blueprintBranch}
        blueprint = {...blueprint, projectPath, branch: blueprintBranch}

        const sourceDeploymentTemplate = deploymentTemplate.source || deploymentTemplate.name

        if(!deploymentTemplate.source && renameDeploymentTemplate) {
            deploymentTemplate.source = sourceDeploymentTemplate
            deploymentTemplate.title = renameDeploymentTemplate;
            deploymentTemplate.name = slugify(renameDeploymentTemplate);
            deploymentTemplate.slug = deploymentTemplate.name
        }
        if(environmentName) {
            const environment = rootGetters.lookupEnvironment(environmentName)
            if(environment?.primary_provider?.type) {
                deploymentTemplate.cloud = environment.primary_provider.type
            }
        }
        commit('updateLastFetchedFrom', {projectPath, templateSlug: deploymentTemplate.name, environmentName, sourceDeploymentTemplate});

        const primary = getters.dtResolveResourceTemplate(deploymentTemplate.primary)
        if(!primary) return false;

        if(renamePrimary) {
            deploymentTemplate.primary = slugify(renamePrimary);
            primary.name = slugify(renamePrimary);
            primary.title = renamePrimary;
        }

        if(syncState) {
            commit('pushPreparedMutation', (accumulator) => {
                const patch = {...deploymentTemplate};
                return [{target: deploymentTemplate.name, patch, typename: 'DeploymentTemplate'}];
            }, {root: true});
            if(renameDeploymentTemplate) {
                commit(
                    'pushPreparedMutation',
                    appendDeploymentTemplateInBlueprint({templateName: deploymentTemplate.name}),
                    {root: true}
                );
            }
        }


        await dispatch('createMatchedResources', {resource: primary, isDeploymentTemplate: true});

        commit('clientDisregardUncommitted', {root: true})
        commit('setDeploymentTemplate', deploymentTemplate)
        commit('createTemplateResource', primary)
        await dispatch('fetchTypesForParams', {params: {}})
        await Promise.all(Object.values(state.resourceTemplates).map(rt => dispatch('recursiveInstantiate', rt)))
        return true;
    },


    async populateEnvironmentResources({getters, rootGetters, state, commit, dispatch}, {resourceTemplates, environmentName}) {
        commit('resetTemplateResourceState')
        commit('updateLastFetchedFrom', {environmentName, noPrimary: true});
        commit('setContext', 'environment')
        let promises = []
        for(const resource of resourceTemplates) {
            if(resource.name == 'primary_provider') continue
            promises.push(dispatch('initMatched', {
                isDeploymentTemplate: true,
                dependentName: null,
                dependentRequirement: null,
                match: resource.name,
                target: null,
                ancestors: null

            }))
        }
        await Promise.all(promises)
        let primary_provider
        if(primary_provider = rootGetters.resolveResourceTemplate('primary_provider')) {
            commit('clientDisregardUncommitted', null, {root: true})

            const createWith = {...primary_provider, title: 'Primary Provider', _permanent: true}
            if([lookupCloudProviderAlias('gcp'), lookupCloudProviderAlias('aws')].includes(primary_provider.type)) {
                commit('createTemplateResource', {...createWith, properties: []})
            } else {
                commit('createTemplateResource', createWith)
            }

            commit('setDeploymentTemplate', {primary: 'primary_provider'})
        }
    },

    async fetchDeploymentIfNeeded({getters, commit, dispatch, rootGetters}, {imported}) {
        let [deploymentName, ...templateName] = imported.split(':')
        templateName = templateName.join(':')
        const projectPath = rootGetters.getHomeProjectPath
        const branch = rootGetters.getCommitBranch
        const deployment = deploymentName?
            rootGetters.getDeployments.find(dep => dep.name == deploymentName):
            rootGetters.getDeployment
        deploymentName = deployment?.name || deploymentName
        const environmentName = deployment?._environment || getters.getCurrentEnvironment?.name

        let deploymentDict

        function assignDeploymentDict() { deploymentDict = rootGetters.getDeploymentDictionary(deploymentName, environmentName) }

        assignDeploymentDict()

        if(!deploymentDict) {
            await dispatch('fetchDeployment',
                {
                    deploymentName,
                    environmentName,
                    projectPath,
                    branch
                })
            assignDeploymentDict()
        }

        if(deploymentDict) {
            const template = rootGetters.getSharedResourceTemplate(
                deploymentName,
                environmentName,
                templateName
            )

            if(!template) {
                commit('createError', {
                    message: `Could not find template '${templateName}'`,
                    context: {
                        environmentName,
                        deploymentName
                    },
                    severity: 'minor'
                }, {root: true})
                return
            }

            if(!getters.resolveResourceTypeFromAny(template.type)) {
                const type = deploymentDict.ResourceType[template.type]
                await dispatch('useProjectState', {
                    root: {
                        ResourceType: {
                            [type.name]: type
                        },
                    },
                    shouldMerge: true
                })
            }
        }
    },

    async initMatched({state, commit, getters, dispatch, rootGetters}, {match, target, isDeploymentTemplate, dependentName, dependentRequirement, ancestors, constraint}) {
        if(!(match || target)) {
            return
        }
        if(state.resourceTemplates.hasOwnProperty(match)) {
            console.warn(`Cannot create matched resource for ${match}: already exists in store`)
            return
        }

        console.assert(dependentName && state.resourceTemplates[dependentName], `Expected '${dependentName}' to exist for its child '${target || match}'`)

        let resolvedDependencyMatch = getters.dtResolveResourceTemplate(match)

        if(!getters.dtResolveResourceTemplate(dependentName)?.directives?.includes('substitute')) {

            const matchedNested = getters.getNestedTemplates(dependentName)[match]

            if(matchedNested) {
                matchedNested._unmangled = match
                matchedNested.name = match = `${match}-${dateSuffix()}`
                commit('createReference', {dependentName, dependentRequirement, resourceTemplate: matchedNested})
                dispatch(
                    'normalizeUnfurlData', {
                        key: 'ResourceTemplate',
                        entry: matchedNested,
                        root: rootGetters.getApplicationRoot
                    })


                commit(
                    'pushPreparedMutation',
                    createResourceTemplate({...matchedNested, dependentName, dependentRequirement, deploymentTemplateName: state.lastFetchedFrom.templateSlug}),
                )
            }

            resolvedDependencyMatch = matchedNested || resolvedDependencyMatch
        }

        let environmentName = state.lastFetchedFrom?.environmentName


        if(!resolvedDependencyMatch && environmentName) {
            let matchedInstance = rootGetters.lookupConnection(environmentName, match)
            if(matchedInstance) {
                matchedInstance = _.cloneDeep(matchedInstance)
                const key = isDeploymentTemplate? 'ResourceTemplate': 'Resource'

                dispatch(
                    'normalizeUnfurlData', {
                        key,
                        entry: matchedInstance,
                        root: rootGetters.getApplicationRoot
                    })

                resolvedDependencyMatch = matchedInstance

                resolvedDependencyMatch.completionStatus = 'connected'
                if(state.context != 'environment') {
                    matchedInstance._external = true
                    resolvedDependencyMatch.readonly = true
                }
            }
        }


        if(!isDeploymentTemplate && resolvedDependencyMatch) {
            resolvedDependencyMatch = {...resolvedDependencyMatch, _external: true}
            // will not be resolvable for external resources
            resolvedDependencyMatch = rootGetters.resolveResource(target) || resolvedDependencyMatch
        }

        const _valid = !!(resolvedDependencyMatch)
        const id = _valid && btoa(resolvedDependencyMatch.name).replace(/=/g, '')

        if(_valid) {
            if(resolvedDependencyMatch.imported) {
                await dispatch('fetchDeploymentIfNeeded', resolvedDependencyMatch)
            }

            let _ancestors = null

            if(ancestors) {
                _ancestors = resolvedDependencyMatch._ancestors
                if(
                    (!resolvedDependencyMatch._ancestors && ancestors && !resolvedDependencyMatch.readonly) ||
                        (Array.isArray(resolvedDependencyMatch._ancestors) && resolvedDependencyMatch._ancestors.length == 0)
                ) {
                    _ancestors = ancestors.concat([[getters.dtResolveResourceTemplate(dependentName), match]])
                }
            }

            const newResource = {...resolvedDependencyMatch, _ancestors}

            commit('createTemplateResource', {
                ...newResource,
                template: !isDeploymentTemplate && resolvedDependencyMatch,
                id,
                readonly: newResource.directives?.includes('default'),
                dependentRequirement,
                dependentName,
                _valid
            })

            await dispatch('createMatchedResources', {resource: newResource, isDeploymentTemplate})
        }

    },

    async createMatchedResources({state, commit, getters, dispatch, rootGetters}, {resource, isDeploymentTemplate}) {
        let promises = []

        for(const dependency of getters.getDependencies(resource.name) || resource.dependencies || []) {
            promises.push(dispatch(
                'initMatched', {
                    isDeploymentTemplate,
                    dependentName: resource.name,
                    dependentRequirement: dependency.name,
                    match: dependency.match,
                    target: dependency.target,
                    ancestors: resource._ancestors,
                    constraint: dependency.constraint
                }
            ))
        }

        await Promise.all(promises)
    },

    async fetchTypesForParams({getters, commit, dispatch, rootGetters}, {params}={}) {
        const environmentName = getters.getCurrentEnvironmentName

        // we'll have a deployment name if we've called create_ensemble
        const deploymentName = rootGetters.lookupDeploymentOrDraft(
            getters.getDeploymentTemplate.name,
            environmentName
        )?.name


        if(params) {
            // for now we are assuming that these two fetches are redundant
            // we always prefer environment repositories when the environment is available
            const fetchPromise = environmentName?
                Promise.all([
                    dispatch('environmentFetchTypesWithParams', {environmentName, deploymentName, params}),
                    // don't fetch blueprint if deployment is already created
                    dispatch('blueprintFetchTypesWithParams', {...params, tempOnly: !!deploymentName})
                ]):
                dispatch('blueprintFetchTypesWithParams', {params})

            await fetchPromise
        }


        // this can go to the receiver since all this information is local to the store
        commit('setAvailableResourceTypes', getters.lookupConfigurableTypes(
            getters.getCurrentEnvironment || (getters.getDeploymentTemplate && {
                connections: [{type: getters.getDeploymentTemplate.cloud}]
            })
        ))
    },


    // TODO split this into two functions (one for updating state and other for serializing resourceTemplates)
    // we can use part of this function to set app state on page load
    // TODO use dependenciesFromResourceType here
    async createNodeResource({ commit, getters, rootGetters, state: _state, dispatch}, {dependentName, dependentRequirement, requirement, name, title, selection, visibility}) {
        let targetType
        if(selection._sourceinfo?.incomplete || selection.directives?.includes('substitute')) {
            if(selection._sourceinfo?.incomplete) {
                commit('addTempRepository', selection._sourceinfo) // consider this repository in future type calls
            }

            const environmentName = getters.getCurrentEnvironmentName
            const implementation_requirements = environmentName && rootGetters.providerTypesForEnvironment(environmentName)
            const params = {
                // we probably want all types the cloudmap repo will access for our template instantation
                // 'extends': selection.name,
                implementation_requirements,
                cloudmap: false,
            }

            await dispatch('fetchTypesForParams', {params})
            targetType = cloneDeep(getters.resolveResourceTypeFromAny(selection.name))

        } else { targetType = cloneDeep(selection) }

        const target = {type: targetType}
        target.description = requirement?.description;
        target._valid = true;
        target.name = name;
        target.title = title;

        target._uncommitted = true
        target.__typename = 'ResourceTemplate'
        target.visibility = visibility || targetType.visibility || 'inherit'
        target.directives = targetType.directives
        target._sourceinfo = targetType._sourceinfo

        // do not pass type metadata into created templates
        target.metadata = {created_by: 'unfurl-gui'}

        const directAncestor = state.resourceTemplates[dependentName]

        dispatch(
            'normalizeUnfurlData', {
                key: 'ResourceTemplate',
                entry: target,
                root: rootGetters.getApplicationRoot
            })


        if(directAncestor) {
            const ancestorDependencies = getters.getDependencies(directAncestor)
            const inputsSchemaFromDirectAncestor = ancestorDependencies.find(dep => dep.name == dependentRequirement)?.constraint?.inputsSchema

            if(inputsSchemaFromDirectAncestor) {
                applyInputsSchema(target.type, inputsSchemaFromDirectAncestor)
            }

            target._ancestors = (directAncestor._ancestors || []).concat([[directAncestor, dependentRequirement]])
        }

        // TODO determine if this is still necessary with normalization
        try { target.properties = Object.entries(targetType.inputsSchema.properties || {}).map(([key, inProp]) => ({name: key, value: inProp.default ?? null}));}
        catch { target.properties = []; }

        if(targetType.requirements?.length > 0) {
            target.dependencies = targetType.requirements.map(req => {
                return {
                    constraint: {...req, visibility: req.visibility || 'visible'},
                    name: req.name,
                    match: req.match || null,
                    target: null
                };

            });
        }

        target.dependentName = dependentName
        target.dependentRequirement = dependentRequirement

        target.id = btoa(target.name).replace(/=/g, '');

        // FIXME these create helpers should accept meta args in a different object than target so they can be passed through as is
        if(state.context == 'environment') {
            commit(
                'pushPreparedMutation',
                createEnvironmentInstance({...target, environmentName: state.lastFetchedFrom.environmentName}),
                {root: true}
            )
        }
        else if (state.context == 'blueprint' && (directAncestor._local || targetType.implementation_requirements.length > 0)) {
            commit(
                'pushPreparedMutation',
                createResourceTemplateInDeploymentTemplate({
                    ...target, deploymentTemplateName: _state.lastFetchedFrom.templateSlug
                }),
                {root: true}
            )
        } else {
            commit(
                'pushPreparedMutation',
                createResourceTemplate({...target, deploymentTemplateName: _state.lastFetchedFrom.templateSlug}),
                {root: true}
            );
        }

        commit("createTemplateResource", target);

        const fieldsToReplace = {
            completionStatus: "created",
            _valid: true
        };

        commit('createReference', {dependentName, dependentRequirement, resourceTemplate: target, fieldsToReplace});
        await dispatch('createMatchedResources', {resource: target, isDeploymentTemplate: true})
        await dispatch('recursiveInstantiate', target)
        return true;
    },

    async connectNodeResource({getters, state, rootGetters, commit, dispatch}, {dependentName, dependentRequirement, externalResource, resource}) {
        const fieldsToReplace = {completionStatus: 'connected', _valid: true};
        const {environmentName} = state.lastFetchedFrom;
        const deploymentTemplateName = state.lastFetchedFrom.templateSlug
        let resourceTemplateNode
        const localCopy = getters.dtResolveResourceTemplate(externalResource || resource?.name)

        if(externalResource) {
            const resourceTemplate = localCopy || rootGetters.lookupConnection(environmentName, externalResource);

            const name = localCopy || shouldConnectWithoutCopy()? externalResource: `__${externalResource}`

            if(resourceTemplate.imported) {
                await dispatch('fetchDeploymentIfNeeded', resourceTemplate)
            }

            let _sourceinfo

            if(!resourceTemplate._sourceinfo) {
                const type = getters.resolveResourceTypeFromAny(resourceTemplate.type)
                _sourceinfo = type?._sourceinfo
            }

            resourceTemplateNode = {
                _sourceinfo,
                ...resourceTemplate,
                name,
                dependentName,
                directives: [],
                dependentRequirement,
                deploymentTemplateName,
                readonly: true,
                _external: !localCopy,
                __typename: 'ResourceTemplate',
            }
        } else if(resource) {
            resourceTemplateNode = {...resource, _external: !localCopy}
        } else {
            throw new Error('connectNodeResource must be called with either "resource" or "externalResource" set')
        }


        // node might have already been created
        if(! localCopy) {
            if(!shouldConnectWithoutCopy()) {
                commit(
                    'pushPreparedMutation',
                    () => [{typename: 'ResourceTemplate', patch: resourceTemplateNode, target: resourceTemplateNode.name}]
                )
            }
        }

        if(!getters.getCardsStacked.find(card => card.name == resourceTemplateNode.name)) {
            commit('createTemplateResource', resourceTemplateNode)
        }

        commit('pushPreparedMutation', appendResourceTemplateInDependent({templateName: resourceTemplateNode.name, dependentName, dependentRequirement, deploymentTemplateName}))

        commit('createReference', {dependentName, dependentRequirement, resourceTemplate: resourceTemplateNode, fieldsToReplace});
    },

    deleteNode({commit, dispatch, getters, state}, {name, action, dependentName, dependentRequirement, recurse=true, shouldRemoveCard=undefined}) {
        if(!state.resourceTemplates[name]) return
        if((!getters.getCardsStacked.find(card => card.name == name)) && state.resourceTemplates[name].metadata?.created_by != 'unfurl-gui') return
        const actionLowerCase = action.toLowerCase();

        const _shouldRemoveCard = shouldRemoveCard ?? getters.directAncestors(name).length <= 1

        if(dependentName) {
            commit('deleteReference', {
                dependentName,
                dependentRequirement,
            });
        }

        if(_shouldRemoveCard){
            if(recurse) {
                for(const templateName of getters.dependenciesRemovableWith(name)) {
                    dispatch('deleteNode', {name: templateName, action: 'delete', recurse: false, shouldRemoveCard: true})
                }
            }

            commit('removeCard', {templateName: name})

            if(state.context == 'environment') {
                commit(
                    'pushPreparedMutation',
                    deleteEnvironmentInstance({
                        templateName: name,
                        environmentName: state.lastFetchedFrom.environmentName,
                        dependentName,
                        dependentRequirement
                    }),
                    {root: true}
                );
            }
            else {
                commit(
                    'pushPreparedMutation',
                    deleteResourceTemplate({
                        templateName: name,
                        deploymentTemplateName: getters.getDeploymentTemplate.name,
                        dependentName, dependentRequirement}),
                    {root: true}
                );
            }

            // clean up all dependencies still matched
            for(const resourceTemplate of Object.values(state.resourceTemplates)) {
                const danglingDependency = resourceTemplate.dependencies?.find(dep => dep.match == name || dep.constraint.match == name)

                if(!danglingDependency) continue

                commit(
                    'pushPreparedMutation',
                    deleteResourceTemplateInDependent({
                        dependentName: resourceTemplate.name,
                        dependentRequirement: danglingDependency.name,
                        deploymentTemplateName: state.deploymentTemplate.name
                    }),
                    {root: true}
                )
            }

        } else {
            commit('pushPreparedMutation', deleteResourceTemplateInDependent({dependentName: dependentName, dependentRequirement, deploymentTemplateName: state.deploymentTemplate.name}), {root: true});
        }

        return true
    },
    updateProperty({state, getters, commit, dispatch}, options) {
        const {deploymentName, templateName, propertyName, propertyValue, propertyPath, debounce} = {
            propertyPath: [],
            debounce: false,
            ...options
        }

        if(debounce) {
            const handle = setTimeout(() => {
                dispatch(
                    'updateProperty',
                    {...options, debounce: false}
                )
            }, debounce)
            dispatch('updateTimeout', {deploymentName, templateName, propertyName, handle})
            return
        }
        const template = state.resourceTemplates[templateName]

        const fullPropertyPath = [...propertyPath, propertyName]
        const templatePropertyValue = template.properties.find(prop => prop.name == propertyPath[0])?.value

        const firstComponent = fullPropertyPath.shift()

        let templateNestedValue = templatePropertyValue

        for(const component of fullPropertyPath) {
            templateNestedValue = (templateNestedValue || {})[component]
        }

        if(_.isEqual(templateNestedValue ?? null, propertyValue ?? null)) return

        const update = {}
        update.propertyName = firstComponent

        if(propertyPath.length > 0) {
            update.propertyValue = _.cloneDeep(templatePropertyValue || {})

            let mutProperty = update.propertyValue
            for(const component of propertyPath.slice(1)) {
                if(!mutProperty[component]) {
                    mutProperty[component] = {}
                }

                mutProperty = mutProperty[component]
            }


            mutProperty[propertyName] = propertyValue
        } else {
            update.propertyValue = _.cloneDeep(propertyValue)
        }

        const inputsSchema = getters.resourceTemplateInputsSchema(templateName)

        commit('templateUpdateProperty', {templateName, ...update})
        if(state.context == 'environment') {
            commit(
                'pushPreparedMutation',
                updatePropertyInInstance({environmentName: state.lastFetchedFrom.environmentName, templateName, ...update, inputsSchema})
            )
        } else {
            commit(
                'pushPreparedMutation',
                updatePropertyInResourceTemplate({deploymentName, templateName, ...update, inputsSchema})
            )
        }
    },
    // I tried this with proper commits but it performed poorly
    updateTimeout(_, {key, deploymentName, templateName, propertyName, handle}) {
        const _key = key || `${deploymentName}.${templateName}.${propertyName}`
        let oldHandle
        if(oldHandle = timeouts[_key]) {
            clearTimeout(oldHandle)
        }
        timeouts[_key] = handle
    },
    updateCardInputValidStatus({commit, dispatch}, {card, status, debounce}) {
        if(debounce) {
            const key = `card:${card.name}`
            const handle = setTimeout(() => {
                dispatch(
                    'updateCardInputValidStatus',
                    {card, status}
                )
            }, debounce)
            dispatch('updateTimeout', {key, handle})
            return
        }
        commit('setInputValidStatus', {card, path: 'all', status})
    },

};

const getters = {
    getDeploymentTemplate: (_state) => {
        return _state.deploymentTemplate;
    },
    getPrimaryCard: (_state) => {
        return _state.resourceTemplates[_state.deploymentTemplate.primary] || {};
    },
    primaryCardProperties(state) {
        const primary = state.resourceTemplates[state.deploymentTemplate.primary]
        switch(primary.__typename) {
            case 'Resource':
                return primary.attributes
            case 'ResourceTemplate':
                return primary.properties
        }

    },
    getCardProperties(state) {
        return function(card) {
            const result = state.resourceTemplates[card?.name || card]
            switch(result?.__typename) {
                case 'Resource': return result.attributes
                case 'ResourceTemplate': return result.properties
                default: return []
            }
        }
    },
    getCardType(state, _a, _b, rootGetters) {
        return function(card) {
            const result = state.resourceTemplates[card?.name || card]
            switch(result?.__typename) {
                case 'Resource': return (typeof result.template == 'string'? rootGetters.resolveResourceTemplate(result.template): result.template)?.type
                case 'ResourceTemplate': return result.type
                default: return result
            }
        }
    },
    getCardExtends(state, getters) {
        return function(card) {
            return getters.resolveResourceTypeFromAny(getters.getCardType(card))?.extends ?? null
        }

    },
    constraintIsHidden(state, getters) {
        return function(dependentName, dependentRequirement) {
            const dep = getters.getDependencies(dependentName)
                ?.find(dep => dep.name == dependentRequirement)

            const match = dep?.match
            const constraint = dep?.constraint

            if(match && state.resourceTemplates[match]?.visibility == 'hidden') return true

            switch(constraint?.visibility) {
                case 'hidden':
                    return true
                case 'inherit':
                    // inherit from dependent card
                    return getters.cardIsHidden(dependentName)
                default: // constraints are visible by default
                    return false
            }
        }
    },
    cardIsHidden(state, getters) {
        return function(cardName) {
            const card = getters.dtResolveResourceTemplate(cardName)
            if(!card) return false

            if(card.__typename == 'Resource') {
                return getters.resourceCardIsHidden(card)
            } else if(card.__typename == 'ResourceTemplate') {
                return getters.templateCardIsHidden(card)
            } else {
                throw new Error(
                    card.__typename ?
                    `Card "${card.title}" has __typename ${card.__typename}` :
                    `Card "${card.title}" has no typename`
                )
            }
        }
    },
    resourceCardIsHidden(state, getters) {
        return function(cardName) {
            // TODO duplicated logic from table_data
            const card = getters.dtResolveResourceTemplate(cardName)

            return getters.templateCardIsHidden(card)
            // below implements hiding cards when they don't appear on the deployment table
        }
    },
    templateCardIsHidden(state, getters) {
        return function(cardName) {
            const card = getters.dtResolveResourceTemplate(cardName)

            switch(card.visibility) {
                case 'hidden':
                    return true
                case 'visible':
                    return false
                default: // templates inherit by default
                    // inherit from constraint
                    return getters.constraintIsHidden(card.dependentName, card.dependentRequirement)
            }
        }
    },
    getCardsStacked: (_state, getters, _a, rootGetters) => {
        if(!_state.lastFetchedFrom) return []
        if(_state.lastFetchedFrom.noPrimary) return Object.values(_state.resourceTemplates).filter(rt => !_state.deploymentTemplate?.primary || rt.name != _state.deploymentTemplate.primary)
        let cards = Object.values(_state.resourceTemplates)

        // hacky workaround for broken dependency hierarchy in resources for default templates
        const isDeployment = _state.deploymentTemplate.__typename == 'Deployment'

        const result = cards.filter((rt) => {
            if(!rootGetters.REVEAL_HIDDEN_TEMPLATES && getters.cardIsHidden(rt.name)) return false
            if(isDeployment) return !_state.deploymentTemplate?.primary || rt.name != _state.deploymentTemplate.primary
            const parentDependencies = getters.getDependenciesMatchingCard(rt.name)

            // card is about to be removed
            if(parentDependencies.length == 0) return false;

            return  (
                rt.__typename == 'ResourceTemplate'?
                parentDependencies.some(dep => dep.match == rt.name):
                parentDependencies.some(dep => dep.target == rt.name)
            )

        });

        // always display cards capable of incrementally deploying
        for(const card of cards) {
            if(result.some(c => c.name == card.name)) continue
            if(getters.cardCanIncrementalDeploy(card)) {
                result.push(card)
            }
        }

        return result
    },
    getCardsInTopology(state, getters, _, rootGetters) {
        return function(namespace) {
            if(namespace == getters.getPrimaryCard.name) {
                return getters.getCardsStacked.filter(card => !card.name.includes(':'))
            } else {
                return getters.getCardsStacked.filter(card => card.name.startsWith(`${namespace}:`))
            }
        }
    },
    lookupVisibleCard(state, getters, _, rootGetters) {
        return function(cardName) {
            return getters.getCardsStacked('*').find(card => card.name == cardName)
        }
    },
    getDependencies: (_state, getters, rootState, rootGetters) => {
        return function(resourceTemplateName) {
            if(!resourceTemplateName) return null

            const rt = (
                rootGetters.resolveResource(resourceTemplateName?.name || resourceTemplateName) ||
                getters.dtResolveResourceTemplate(resourceTemplateName)
            )

            if(!rt) return null

            if(rt.__typename == 'Resource') {
                return rt.connections
            }

            let dependencies = _.cloneDeep(rt.dependencies || [])

            if(dependencies.length == 0) return []

            const requirementsFilterGroups = getters.groupRequirementFilters(resourceTemplateName)


            for(const dep of dependencies) {
                if(!requirementsFilterGroups[dep.name]?.length) continue
                dep.constraint = _.mergeWith(dep.constraint, ...requirementsFilterGroups[dep.name], customMerge)
            }

            dependencies = dependencies.filter(dep => dep.constraint.max > 0)

            if(rt.directives?.includes('substitute')) {
                dependencies = dependencies.filter(dep => {
                    for(const otherDep of dependencies) {
                        if(dep == otherDep) continue
                        if(dep.match == otherDep.name) {
                            return false
                        }
                    }
                    return true
                })
            }

            return dependencies
        };
    },
    cardStatus(state) {
        return function(resourceName) {
            return state.resourceTemplates[resourceName]?.status
        }
    },
    getBuriedDependencies(state, getters) {
        return function(cardName) {
            if(!getters.cardIsHidden(cardName?.name || cardName)) return []
            const card = getters.dtResolveResourceTemplate(cardName)
            const result = []
            for(const dependency of getters.getDependencies(card.name)) {
                if(!getters.constraintIsHidden(card.name, dependency.name)) {
                    result.push({card, dependency, buried: true})
                }
                let match
                if(match = dependency.target || dependency.match) { // try to support resources
                    for(const buriedDescendent of getters.getBuriedDependencies(match)) {
                        result.push(buriedDescendent)
                    }
                }
            }
            return result
        }
    },
    getDisplayableDependenciesByCard(state, getters) {
        return function(cardName) {
            const card = getters.dtResolveResourceTemplate(cardName)
            const result = []
            if(!card) return result
            for(const dependency of getters.getDependencies(card.name)) {
                if(!getters.constraintIsHidden(card.name, dependency.name)) {
                    result.push({dependency, card})
                }

                let match
                if (match = dependency.target || dependency.match) {
                    for(const buriedDescendent of getters.getBuriedDependencies(match)) {
                        result.push(buriedDescendent)
                    }
                }
            }
            return result
        }
    },
    requirementMatchIsValid: (_state, getters)=> function(requirement) {
        return !!getters.resolveRequirementMatchTitle(requirement)
    },

    resolveRequirementMatchTitle: (_state, getters, _, rootGetters) => function(requirement) {
        const match = typeof requirement == 'string'? requirement:
            state.context == 'deployment' ? requirement.target : requirement.match
        const matchInResourceTemplates = _state.resourceTemplates[match]?.title;
        if(matchInResourceTemplates) return matchInResourceTemplates;
        // TODO figure out how to handle resources of a service
        return state.context != 'environment' && rootGetters.lookupConnection(_state.lastFetchedFrom.environmentName, match)?.title;
    },

    resolveRequirementMatchChildren: (_state, getters) => function (requirement) {
        const match = typeof requirement == 'string'? requirement:
            state.context == 'deployment' ? requirement.target : requirement.match
        const resourceTemplate = _state.resourceTemplates[match]
        let children = []
        if (resourceTemplate?.dependencies) {
            for (const dep of resourceTemplate?.dependencies) {
                if (dep.constraint.visibility === 'visible' && dep?.completionStatus) {
                    // dependency is visible && there is completionStatus field (i think the status doesn't matter here)
                    children.push(_state.resourceTemplates[dep.match]?.title)
                } else {
                    // dependency is hidden or inherit || no completionStatus field
                    if (dep.match) {
                        children = children.concat(getters.resolveRequirementMatchChildren(dep.match))
                    }
                }
            }
        }
        return children
    },
    cardInputsAreValid(state) {
        return function(_card) {
            const card = typeof(_card) == 'string'? state.resourceTemplates[_card]: _card;
            if(!card) return true
            if(card.imported) return true
            if(!card.properties?.length) return true
            return (Object.values(state.inputValidationStatus[card.name] || {})).every(status => status == 'valid')
        };
    },

    cardDependenciesAreValid(state, getters) {
        return function(_card) {
            const card = typeof(_card) == 'string'? state.resourceTemplates[_card]: _card;
            if(!card) return true
            if(card.imported) return true
            const dependencies = getters.getDependencies(card)
            if(!dependencies?.length) return true;
            return dependencies.every(dependency => (
                (dependency.constraint.min == 0 && !dependency.match) ||
                (getters.requirementMatchIsValid(dependency) && getters.cardIsValid(dependency.match))
            ))
        };

    },

    cardIsValid(state, getters) {
        return function(card) {
            return getters.cardInputsAreValid(card) && getters.cardDependenciesAreValid(card);
        };
    },

    lookupCardPropertyValue(state) {
        // TODO support attributes
        return function(card, property) {
            return state.resourceTemplates[card]?.properties?.find(prop => prop.name == property)?.value
        }
    },

    getCurrentEnvironment(state, _getters, _, rootGetters) {
      try {
        return rootGetters.lookupEnvironment(state.lastFetchedFrom.environmentName)
      } catch(e) {
        return null
      }
    },

    getCurrentEnvironmentName(state) {
        return state.lastFetchedFrom?.environmentName
    },

    getCurrentEnvironmentType(_, getters) {
        return getters.getCurrentEnvironment?.primary_provider?.type
    },

    instantiableResourceTypes(state) {
        let result = state.availableResourceTypes.filter(rt => rt.visibility != 'hidden')

        // if a type is marked as deprecated by another type among validSubclasses, filter it out
        let deprecatedTypes = []
        result.forEach(type => {
            if(type.metadata.deprecates) {
                deprecatedTypes = _.union(deprecatedTypes, type.metadata.deprecates)
            }
        })
        if(deprecatedTypes.length > 0) {
            return result.filter(type => !deprecatedTypes.includes(type.name))
        }
        return result

    },

    availableResourceTypesForRequirement(state, getters) {
        return function(requirement, all=false) {
            if(!requirement) return []
            const types = all? state.availableResourceTypes: getters.instantiableResourceTypes
            let result = types.filter(type => {
                const isValidImplementation = [
                    ...(type.extends || []),
                    // allow types declaring deprecates to substitute for any type they deprecate
                    ...(type.metadata.deprecates || [])
                        .map(deprecated => getters.resolveResourceTypeFromAny(deprecated)?.extends)
                        .flat()
                ].includes(requirement.constraint?.resourceType)
                return isValidImplementation
            })


            // TODO dry this up
            if(all) {
                let deprecatedTypes = []
                result.forEach(type => {
                    if(type.metadata.deprecates) {
                        deprecatedTypes = _.union(deprecatedTypes, type.metadata.deprecates)
                    }
                })
                if(deprecatedTypes.length > 0) {
                    return result.filter(type => !deprecatedTypes.includes(type.name))
                }
            }

            return result
        }
    },

    resolveResourceTypeFromAny(state, getters, _b, rootGetters) {
        return function(typeName) {
            const environmentResourceType = rootGetters.environmentResolveResourceType(getters.getCurrentEnvironmentName, typeName)
            const dictionaryResourceType = rootGetters.resolveResourceType(typeName)

            // generally prefer environmentResourceType
            const candidates = [environmentResourceType, dictionaryResourceType].filter(type => !!type)

            const merge = {}

            const icon = [environmentResourceType, dictionaryResourceType].find(type => type?.icon)?.icon
            if(icon) {
                merge["icon"] = icon
            }

            // immediately return a type if it is 'substitute' and not incomplete
            for(const type of candidates) {
                if(type._sourceinfo?.incomplete) continue
                if(type.directives?.includes('substitute') || type.metadata?.alias) return {...type, ...merge}
            }

            // prefer complete
            let result = candidates.find(type => !type._sourceinfo?.incomplete)
            result = (result || environmentResourceType || dictionaryResourceType) ?? null

            if(!result) return result
            return {...result, ...merge}
        }
    },

    lookupConfigurableTypes(state, getters, _b, rootGetters) {
        return function(environment) {
            const resolver = rootGetters.resolveResourceTypeFromAny
            return Object.keys(
                {
                    ...rootGetters.blueprintResourceTypeDict,
                    ...rootGetters.environmentResourceTypeDict(environment)
                })
                .map(key => getters.resolveResourceTypeFromAny(key))
                .filter(rt => isConfigurable(rt, environment, resolver))
        }
    },


    dtResolveResourceTemplate(state, _a, _b, rootGetters) {
        return function(_resourceTemplate) {
            let sourceDt, templateFromSource
            const resourceTemplate = _resourceTemplate?.name || _resourceTemplate

            const localTemplate = state.resourceTemplates[resourceTemplate]

            if(localTemplate && !localTemplate.directives?.includes('default')) return localTemplate

            if(sourceDt = state.lastFetchedFrom?.sourceDeploymentTemplate) {
                templateFromSource = rootGetters.resolveLocalResourceTemplate(sourceDt, resourceTemplate)
            }
            const templateFromStore = rootGetters.resolveResourceTemplate(resourceTemplate)

            if(templateFromStore && !templateFromStore.directives?.includes('default')) {
                return templateFromStore
            }

            return templateFromSource || templateFromStore || localTemplate
        }
    },

    calculateParentConstraint(state, getters) {
        return function(resourceTemplate) {
            const rt = typeof resourceTemplate == 'string' || resourceTemplate.__typename == 'Resource'?
                getters.dtResolveResourceTemplate(resourceTemplate?.template || resourceTemplate) :
                resourceTemplate

            if(!rt._ancestors) return null

            // TODO rt.dependencies should have been normalized to an empty array
            const ancestorConstraints = _.cloneDeep(rt._ancestors || []).map(([rt, req]) => rt.dependencies?.find(dep => dep.name == req)?.constraint)

            const parentConstraint = ancestorConstraints.reduce((prev, cur) => _.merge(cur, ...(prev?.requirementsFilter || [])), null)

            return parentConstraint
        }

    },

    groupRequirementFilters(state, getters) {
        return function(resourceTemplate) {
            const parentConstraint = getters.calculateParentConstraint(resourceTemplate)
            return _.groupBy(parentConstraint?.requirementsFilter || [], 'name')
        }
    },

    resourceTemplateInputsSchema(state, getters) {
        return function(resourceTemplate, {strict}={}) {
            const rt = typeof resourceTemplate == 'string' || resourceTemplate.__typename == 'Resource'?
                getters.dtResolveResourceTemplate(resourceTemplate?.template || resourceTemplate) :
                resourceTemplate

            if(strict && !rt) {
                throw new Error(`Resource template '${resourceTemplate || resourceTemplate?.template}' not found`)
            }
            // we don't have the resource template we need loaded
            // TODO figure out how to handle shared resources with node_filter
            if(!rt && resourceTemplate?.type) {
                return getters.resolveResourceTypeFromAny(resourceTemplate.type)?.inputsSchema
            }

            const type = _.cloneDeep(getters.resolveResourceTypeFromAny(rt.type))

            if(strict && type?._sourceinfo?.incomplete) {
                throw new Error(`'${type.name}' is incomplete`)
            }

            if(strict && !type?.inputsSchema) {
                throw new Error(`Could not resolve type with inputsSchema for '${rt.type}'`)
            }

            if(type?.inputsSchema) {
                applyInputsSchema(type, getters.calculateParentConstraint(resourceTemplate)?.inputsSchema)
            }

            return type?.inputsSchema
        }
    },

    lookupEnvironmentVariable(state, _a, _b, rootGetters) {
        return function(variableName) {
            const _variableName = Array.isArray(variableName)? variableName[0]: variableName
            return (
              rootGetters.lookupVariableByEnvironment(_variableName, state.lastFetchedFrom.environmentName) ||
              rootGetters.lookupVariableByEnvironment(_variableName, '*')
            )
        }
    },

    getParentDependency(state, getters) {
        return function(dependencyName) {
            console.warn('Do not use getParentDependency - a template may fill multiple dependencies')
            if(!dependencyName) return null
            let primaryName = state.deploymentTemplate.primary
            if (dependencyName === primaryName) return null

            let dependency = state.resourceTemplates[dependencyName]
            let dependent = getters.getParentDependency(dependency.dependentName) || dependency
            return dependent
        }
    },

    getDependent(state) {
        return function(dependencyName) {
            console.warn('Do not use getDependent - a template may fill multiple dependencies')
            if(!dependencyName) return null
            let primaryName = state.deploymentTemplate.primary
            if (dependencyName === primaryName) return null

            const dependency = state.resourceTemplates[dependencyName]
            try {
                return state.resourceTemplates[dependency.dependentName]
            } catch(e) {
                console.error(e)
                return null
            }
        }
    },

    getPrimary(state) {
        return state.resourceTemplates[state.deploymentTemplate.primary]
    },

    cardCanIncrementalDeploy(state, getters) {
        return function(card) {
            // NOTE: hardcoded names
            return getters.getCardExtends(card)?.find(e => e.startsWith('ContainerImageSource@'))
        }
    },

    hasIncrementalDeployOption(state, getters) {
        return Object.values(state.resourceTemplates).some(card => getters.cardCanIncrementalDeploy(card))
    },

    getCurrentContext(state) {
        return state.context
    },

    editingDeployed(state, getters, _b, rootGetters) {
        const deployment = rootGetters.resolveDeployment(state.deploymentTemplate.name)
        return !!deployment?.workflow
    },

    editingTorndown(_a, getters, _b, rootGetters) {
        // TODO use deployment status
        const deployment = rootGetters.resolveDeployment(state.deploymentTemplate.name)
        return deployment?.workflow == 'undeploy'
    },

    getValidationStatuses(state) {
        return state.inputValidationStatus
    },

    deployTooltip(state, getters) {
        if(getters.cardIsValid(getters.getPrimaryCard)) return null

        const statuses = Object.values(getters.getValidationStatuses)

        if(statuses.includes('error')) {
            return 'Some components have missing or invalid values'
        }

        if(statuses.includes('missing')) {
            return 'Some components are missing inputs'
        }

        return 'Not all required components have been created or connected'
    },

    lastFetchedFrom(state) { return state.lastFetchedFrom },

    getDependenciesMatchingCard(state) {
        return function(cardName) {
            const result = []
            Object.values(state.resourceTemplates).forEach(rt => {
                for(const dep of rt.dependencies || []) {
                    if(dep.match == cardName || dep.constraint.match == cardName) {
                        result.push(dep)
                    }
                }
            })
            return result
        }
    },

    getCardUtilization(state, getters) {
        return function(cardName) {
            let result = 0
            getters.getDependenciesMatchingCard(cardName).forEach(dep => {
                result += dep.constraint._utilization
            })
            return result
        }
    },

    getValidConnections(state, getters, _a, rootGetters) {
        return function(cardName, requirement) {
            const card = getters.dtResolveResourceTemplate(cardName)
            const constraintType = constraintTypeFromRequirement(requirement)
            if(!(card && constraintType)) {
                return null
            }

            const result = []

            const environmentName = state.lastFetchedFrom?.environmentName

            if(environmentName) {
                result.push(...rootGetters.getValidEnvironmentConnections(environmentName, requirement, getters.resolveResourceTypeFromAny))
            }


            const allTemplates = _.union(
                Object.keys(state.resourceTemplates),
                rootGetters.topLevelTemplates,
                rootGetters.localResourceTemplates(
                    getters.getDeploymentTemplate?.source || getters.getDeploymentTemplate?.name
                ),
            ).map(getters.dtResolveResourceTemplate)

            result.push(...allTemplates.filter(rt => {
                const type = getters.resolveResourceTypeFromAny(rt.type)
                if(! type?.extends?.includes(constraintType)) return

                // type matches

                const utilization = getters.getCardUtilization(rt.name)
                if(rt._maxUtilization >= utilization + (requirement._utilization ?? requirement.constraint?._utilization)) {
                    return true
                }
            }))

            // TODO dry this up

            let deprecatedTypes = []

            for(const template of result) {
                const templateType = getters.resolveResourceTypeFromAny(template.type)
                let deprecates
                if(deprecates = templateType?.metadata?.deprecates) {
                    deprecatedTypes = _.union(deprecates, deprecatedTypes)
                }
            }


            if(deprecatedTypes.length) {
                return result.filter(templ => !deprecatedTypes.includes(templ.type))
            }

            return result
        }
    },

    getCurrentProjectPath(state) {
        return state.deploymentTemplate?.projectPath
    },

    getCurrentRepositories(_a, getters, _b, rootGetters) {
        const result = [
            rootGetters.blueprintRepositories,
            rootGetters.currentEnvironmentRepositories(getters.getCurrentEnvironmentName)
        ]

        return result.flat()
    },

    repositoryInScope(_, getters) {
        return function (repo) {
            try {
                return getters.getCurrentRepositories.some(currentRepo => importsAreEqual(currentRepo, repo))
            } catch(e) {
                console.warn(`Can't read repository url from source info: ${e.message}`)
                return true  // just assume that local file paths in url are already in scope
            }
        }
    },

    directAncestors(state, getters) {
        return function(card) {
            const cardName = card?.name || card
            return Object.values(state.resourceTemplates).filter(a => {
                if(a.name == cardName) return false
                // diverges from implementation in dependenciesRemovableWith
                // if(rt.metadata?.created_by != 'unfurl-gui') return false

                return a.dependencies?.some(dep => dep.match == cardName)
            })
        }
    },

    dependenciesRemovableWith(state, getters) {
        return function(card) {
            const cardName = card?.name || card

            const wouldBeOrphaned = getters.dtResolveResourceTemplate(cardName).dependencies.filter(dep => {
                if(!dep.match) return false

                const rt = getters.dtResolveResourceTemplate(dep.match)
                if(rt?.metadata?.created_by != 'unfurl-gui') return false

                // ancestors should be tracked
                // this is the best we can do if they weren't for some reason
                console.assert(rt._ancestors)
                if(!rt._ancestors) {
                    return true
                }

                const remainingAncestors = rt._ancestors.filter(([node, dependencyName]) => {
                    if(node.name == cardName) return false
                    return node.dependencies.some(dep => dep.match == rt.name)
                })

                return remainingAncestors.length == 0
            }).map(dep => dep.match)

            return _.uniqBy([
                ...wouldBeOrphaned,
                ...wouldBeOrphaned.map(getters.dependenciesRemovableWith).flat()
            ])
        }
    },

    infallibleGetCardTitle(state, getters) {
        return function(card) {
            const cardName = card?.name || card

            return state.resourceTemplates[cardName]?.title || cardName
        }

    },

    getNestedTemplates(state, getters, _rootState, rootGetters) {
        // determine which nested templates are "visible" for a given template (target)
        return function(target) {
            if(!target) return {}
            if(typeof(target) == 'string') {
                target = getters.dtResolveResourceTemplate(target)
            }

            let nestedTemplates = rootGetters.nestedTemplatesByPrimary[target.type?.name || target.type]
            if(nestedTemplates) {
                const cloud = getters.getDeploymentTemplate?.cloud?.split('@')?.shift()
                const nestedLocalTemplates = nestedTemplates?.local[cloud]
                return {...nestedTemplates.shared, ...nestedLocalTemplates}
            } else if(target._ancestors?.length){
                return getters.getNestedTemplates(_.last(target._ancestors)[0])
            }
            return {}
        }

    }
};

export default {
    state,
    mutations,
    actions,
    getters
};
