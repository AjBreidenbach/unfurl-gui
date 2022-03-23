<script>
import {GlIcon, GlButton} from '@gitlab/ui'
import {DetectIcon} from '../../../vue_shared/oc-components'
import {mapGetters, mapActions} from 'vuex'
import {bus} from '../../bus'
import { __ } from '~/locale';

export default {
    name: 'Dependency',
    props: {
        card: Object,
        dependency: Object,
        idx: Number,
        displayValidation: { type: Boolean, default: true, },
        displayStatus: { type: Boolean, default: false, },
        readonly: { type: Boolean, default: false }

    },
    components: {
        GlIcon, GlButton,
        DetectIcon,
    },
    computed: {
        ...mapGetters([
            'requirementMatchIsValid',
            'resolveRequirementMatchTitle',
            'availableResourceTypesForRequirement',
            'getValidConnections',
            'isMobileLayout',
            'resolveResourceTypeFromAny'
        ])

    },
    methods: {
        ...mapActions([
            'setRequirementSelected',
        ]),

        //TODO 
        getCurrentActionLabel(requirement) {
            switch(requirement.completionStatus) {
              case 'connected': return __('Disconnect')
              case 'created': return __('Remove')
              default: return __(this.DEFAULT_ACTION_LABEL)
            }
        },


        findElementToScroll({requirement}) {
            bus.$emit('moveToElement', {elId: requirement.match});
        },
        sendRequirement(requirement) {
            if(this.hasRequirementsSetter) {
                this.setRequirementSelected({requirement, titleKey: this.titleKey});  // TODO trying to make this redundant
            }
            
            bus.$emit('placeTempRequirement', {dependentName: this.card.name, dependentRequirement: requirement.name, requirement, action: 'create'});
        },
        openDeleteModal(index, action=__("Remove")) {
            const dependency = this.card.dependencies[index]
            //const card = this.resolveResourceTemplate(dependency.match)
            bus.$emit('deleteNode', {name: dependency.match, level: this.level, action, dependentRequirement: dependency.name, dependentName: this.card.name});
        },

        connectToResource(requirement) {
            if(this.hasRequirementsSetter) {
                this.setRequirementSelected({dependentName: this.card.name, dependentRequirement: requirement.name, requirement, titleKey: this.titleKey}); // TODO trying to make this redundant
            }
            bus.$emit('launchModalToConnect', {dependentName: this.card.name, dependentRequirement: requirement.name, requirement, action: 'connect'});
        },

        hasRequirementsSetter() {
            return Array.isArray(this.$store._actions.setRequirementSelected)
        },

        requirementSatisfied(requirement) {
            const result =  !!(requirement.constraint.min == 0 || requirement.status || this.requirementMatchIsValid(requirement))
            return result
        },
        canConnectServices() {
            return this.$route.name != 'templatePage'
        },


    }
}
</script>
<template>
    <div class="gl-responsive-table-row oc_table_row">
        <div
            class="table-section oc-table-section section-wrap text-truncate section-40 align_left justify-content-between">
            <div>
                <detect-icon :size="16" class="gl-mr-2 icon-gray" :type="resolveResourceTypeFromAny(dependency.constraint.resourceType)" />
                <span class="text-break-word title" style="font-weight: bold; color: #353545">{{ dependency.name }}</span>
                <div class="oc_requirement_description gl-mb-2">
                    {{ dependency.description}}
                </div>
            </div>
            <div v-if="isMobileLayout" class="ml-2 mr-2">
                <gl-icon
                    v-if="displayValidation"
                    :size="14"
                    :class="{
                            'icon-green': requirementSatisfied(dependency),
                            'icon-red': !requirementSatisfied(dependency),
                            }"
                    :name="requirementSatisfied(dependency) ? 'check-circle-filled' : 'warning-solid'"
                    />
                <span v-if="requirementMatchIsValid(dependency)" class="text-break-word oc_resource-details">

                    <a href="#" @click.prevent=" findElementToScroll({requirement: dependency}) ">
                        <span v-if="displayStatus">
                            <status-icon :status="cardStatus(dependency.target)" />
                        </span>

                        {{ resolveRequirementMatchTitle(dependency) }}
                    </a>
                </span>
            </div>
        </div>
        <!-- TODO fix this -->
        <div v-if="!isMobileLayout"
            class="table-section oc-table-section section-wrap text-truncate section-30 align_left">
            <gl-icon
                v-if="displayValidation"
                :size="14"
                :class="{
                    'icon-green': requirementSatisfied(dependency),
                    'icon-red': !requirementSatisfied(dependency),
                }"
                :name="requirementSatisfied(dependency) ? 'check-circle-filled' : 'warning-solid'"
            />
            <span v-if="requirementMatchIsValid(dependency)" class="text-break-word oc_resource-details">

                <a href="#" @click.prevent=" findElementToScroll({requirement: dependency}) ">
                    <span v-if="displayStatus">
                        <status-icon :status="cardStatus(dependency.target)" />
                    </span>

                    {{ resolveRequirementMatchTitle(dependency) }}
                </a>
            </span>
        </div>

        <div
            v-if="!readonly && requirementMatchIsValid(dependency)"
            class="table-section oc-table-section section-wrap text-truncate section-30 d-inline-flex flex-wrap justify-content-end">
            <gl-button
            v-if="getCurrentActionLabel(dependency) !== 'Disconnect'"
                title="edit"
                :aria-label="__(`edit`)"
                type="button"
                class="oc_requirements_actions"
                @click.prevent="findElementToScroll({requirement: dependency})"
                >{{ __('Edit') }}</gl-button>
            <gl-button
                :title="__(dependency.completionStatus || DEFAULT_ACTION_LABEL)"
                :aria-label="__(dependency.completionStatus || DEFAULT_ACTION_LABEL)"
                type="button"
                class="gl-ml-3 oc_requirements_actions"
                @click.prevent="openDeleteModal(idx, getCurrentActionLabel(dependency))">
                {{
                    getCurrentActionLabel(dependency) 
                }}</gl-button>
        </div>
        <div
            v-else-if="!readonly"
            class="table-section oc-table-section section-wrap text-truncate section-30 d-inline-flex flex-wrap justify-content-end">
            <gl-button
                v-if="canConnectServices"
                title="connect"
                :aria-label="__(`connect`)"
                type="button"
                class="oc_requirements_actions"
                :disabled="getValidConnections($route.params.environment, dependency).length == 0"
                @click.prevent="connectToResource(dependency)"
            >{{ __('Connect') }}</gl-button>

            <gl-button
                title="create"
                :aria-label="__(`create`)"
                type="button"
                class="gl-ml-3 oc_requirements_actions"
                :disabled="availableResourceTypesForRequirement(dependency).length == 0"
                @click="sendRequirement(dependency)">{{ __('Create') }}</gl-button>
        </div>
    </div>
</template>